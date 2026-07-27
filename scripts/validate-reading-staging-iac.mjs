import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const templateUrl = new URL("../infrastructure/reading-staging/template.json", import.meta.url);

function fail(message) {
  throw new Error(`READING_STAGING_IAC_INVALID: ${message}`);
}

function statements(template, roleName) {
  const policies = template.Resources?.[roleName]?.Properties?.Policies;
  if (!Array.isArray(policies)) fail(`${roleName} policies are missing`);
  return policies.flatMap((policy) => policy.PolicyDocument?.Statement ?? []);
}

function actions(statement) {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function text(value) {
  return JSON.stringify(value);
}

export async function loadReadingStagingTemplate(url = templateUrl) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function validateReadingStagingTemplate(template) {
  if (template.AWSTemplateFormatVersion !== "2010-09-09") fail("unexpected template version");
  if (template.Parameters?.Environment?.Default !== "staging" || text(template.Parameters.Environment.AllowedValues) !== '["staging"]') {
    fail("environment must be fixed to staging");
  }
  const serialized = text(template);
  for (const forbidden of ["BEDROCK_MODEL_ID", "global.", "production", "READING_DEEP_GENERATE_API_ENABLED"]) {
    if (serialized.toLowerCase().includes(forbidden.toLowerCase())) fail(`forbidden token: ${forbidden}`);
  }

  const expectedTypes = {
    "AWS::DynamoDB::Table": 6,
    "AWS::SQS::Queue": 4,
    "AWS::Lambda::Function": 4,
    "AWS::Lambda::EventSourceMapping": 2,
    "AWS::ApiGatewayV2::Route": 2,
    "AWS::Logs::LogGroup": 4,
  };
  const resourceValues = Object.values(template.Resources ?? {});
  for (const [type, count] of Object.entries(expectedTypes)) {
    const actual = resourceValues.filter((resource) => resource.Type === type).length;
    if (actual !== count) fail(`${type} expected ${count}, received ${actual}`);
  }

  for (const [name, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type === "AWS::DynamoDB::Table") {
      if (resource.Properties?.BillingMode !== "PAY_PER_REQUEST") fail(`${name} billing mode`);
      if (resource.Properties?.DeletionProtectionEnabled !== true) fail(`${name} deletion protection`);
      if (resource.Properties?.SSESpecification?.SSEEnabled !== true) fail(`${name} encryption`);
      if (resource.DeletionPolicy !== "Retain" || resource.UpdateReplacePolicy !== "Retain") fail(`${name} retention`);
      if (resource.Properties?.TableName !== undefined) fail(`${name} must not guess a physical name`);
    }
    if (resource.Type === "AWS::IAM::Role") {
      for (const statement of statements(template, name)) {
        if (statement.Resource === "*" || (Array.isArray(statement.Resource) && statement.Resource.includes("*"))) {
          fail(`${name} contains wildcard resource`);
        }
      }
    }
  }

  const request = statements(template, "ReadingRequestRole");
  if (request.some((statement) => actions(statement).some((action) => String(action).startsWith("bedrock:")))) fail("request role can invoke Bedrock");
  if (!request.some((statement) => actions(statement).includes("sqs:SendMessage"))) fail("request role cannot enqueue");

  const status = statements(template, "ReadingStatusRole");
  const statusActions = status.flatMap(actions);
  if (text(statusActions) !== '["logs:CreateLogStream","logs:PutLogEvents","dynamodb:GetItem"]') fail("status role is not read-only");
  const statusDynamo = status.find((statement) => actions(statement).includes("dynamodb:GetItem"));
  if (text(statusDynamo?.Resource) !== text([{ "Fn::GetAtt": ["ReadingJobsTable", "Arn"] }, { "Fn::GetAtt": ["ReadingHistoryTable", "Arn"] }])) {
    fail("status role table scope");
  }

  for (const mode of ["Light", "Deep"]) {
    const worker = statements(template, `${mode}WorkerRole`);
    const queueStatement = worker.find((statement) => actions(statement).includes("sqs:ReceiveMessage"));
    if (text(queueStatement?.Resource) !== text({ "Fn::GetAtt": [`${mode}Queue`, "Arn"] })) fail(`${mode} worker queue scope`);
    const profileStatement = worker.find((statement) => actions(statement).includes("bedrock:InvokeModel") && !statement.Condition);
    if (text(profileStatement?.Resource) !== text({ Ref: `${mode}InferenceProfileArn` })) fail(`${mode} worker profile scope`);
    const modelStatement = worker.find((statement) => actions(statement).includes("bedrock:InvokeModel") && statement.Condition);
    if (text(modelStatement?.Resource) !== text([{ Ref: `${mode}TokyoFoundationModelArn` }, { Ref: `${mode}OsakaFoundationModelArn` }])) fail(`${mode} worker model scope`);
    if (text(modelStatement?.Condition) !== text({ StringEquals: { "bedrock:InferenceProfileArn": { Ref: `${mode}InferenceProfileArn` } } })) fail(`${mode} inference profile condition`);
  }

  const lightQueue = template.Resources.LightQueue.Properties;
  const deepQueue = template.Resources.DeepQueue.Properties;
  if (lightQueue.VisibilityTimeout !== 720 || deepQueue.VisibilityTimeout !== 1440) fail("queue visibility timeout");
  if (template.Resources.LightWorkerFunction.Properties.Timeout !== 120 || template.Resources.DeepWorkerFunction.Properties.Timeout !== 240) fail("worker timeout");
  if (template.Resources.LightEventSourceMapping.Properties.FunctionResponseTypes?.[0] !== "ReportBatchItemFailures") fail("light partial batch response");
  if (template.Resources.DeepEventSourceMapping.Properties.FunctionResponseTypes?.[0] !== "ReportBatchItemFailures") fail("deep partial batch response");

  const requestIntegration = template.Resources.ReadingRequestIntegration.Properties;
  const apiName = template.Resources.ReadingHttpApi.Properties.Name?.["Fn::Sub"];
  if (apiName !== "${AWS::StackName}-reading-http-api") fail("HTTP API name must be stack scoped");
  if (requestIntegration.RequestParameters?.["overwrite:path"] !== undefined) fail("public /reading path must not be rewritten");
  if (template.Resources.ReadingRequestRoute.Properties.RouteKey !== "POST /reading") fail("request route");
  if (template.Resources.ReadingStatusRoute.Properties.RouteKey !== "GET /reading/status") fail("status route");
  const requestSourceArn = template.Resources.ReadingRequestInvokePermission.Properties.SourceArn?.["Fn::Sub"];
  const statusSourceArn = template.Resources.ReadingStatusInvokePermission.Properties.SourceArn?.["Fn::Sub"];
  if (!requestSourceArn?.endsWith("/${Environment}/POST/reading")) fail("request invoke stage scope");
  if (!statusSourceArn?.endsWith("/${Environment}/GET/reading/status")) fail("status invoke stage scope");

  const functionNames = ["ReadingRequestFunction", "ReadingStatusFunction", "LightWorkerFunction", "DeepWorkerFunction"];
  for (const name of functionNames) {
    const properties = template.Resources[name].Properties;
    if (properties.Runtime !== "nodejs22.x" || properties.Handler !== "index.handler") fail(`${name} runtime`);
    if (!properties.FunctionName?.["Fn::Sub"]?.startsWith("${AWS::StackName}-")) fail(`${name} must be stack scoped`);
  }
  for (const parameter of ["ReadingGenerateApiEnabled", "ReadingAsyncPaidEnabled", "ReadingStatusApiEnabled", "ReadingBedrockEnabled", "WorkerEventSourceMappingsEnabled"]) {
    if (template.Parameters[parameter].Default !== "false") fail(`${parameter} must fail closed`);
  }
  for (const mode of ["Light", "Deep"]) {
    if (text(template.Resources[`${mode}EventSourceMapping`].Properties.Enabled) !== text({ "Fn::If": ["WorkersEnabled", true, false] })) fail(`${mode} event source kill switch`);
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const template = await loadReadingStagingTemplate();
  validateReadingStagingTemplate(template);
  process.stdout.write("READING_STAGING_IAC_LOCAL_VALIDATE: PASS\n");
}
