import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProductionTemplate } from "./generate-reading-production-iac.mjs";

export const templateUrl = new URL("../infrastructure/reading-production/template.json", import.meta.url);

function fail(message) {
  throw new Error(`READING_PRODUCTION_IAC_INVALID: ${message}`);
}

function text(value) {
  return JSON.stringify(value);
}

function actions(statement) {
  return Array.isArray(statement?.Action) ? statement.Action : [statement?.Action].filter(Boolean);
}

function statements(template, roleName) {
  const policies = template.Resources?.[roleName]?.Properties?.Policies;
  if (!Array.isArray(policies)) fail(`${roleName} policies are missing`);
  return policies.flatMap((policy) => policy.PolicyDocument?.Statement ?? []);
}

function visit(value, callback, path = "$") {
  callback(value, path);
  if (Array.isArray(value)) value.forEach((child, index) => visit(child, callback, `${path}[${index}]`));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) visit(child, callback, `${path}.${key}`);
  }
}

function validateReferences(template) {
  const resources = new Set(Object.keys(template.Resources ?? {}));
  const parameters = new Set(Object.keys(template.Parameters ?? {}));
  const pseudo = new Set(["AWS::AccountId", "AWS::NotificationARNs", "AWS::NoValue", "AWS::Partition", "AWS::Region", "AWS::StackId", "AWS::StackName", "AWS::URLSuffix"]);
  visit(template.Resources, (value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (typeof value.Ref === "string" && !resources.has(value.Ref) && !parameters.has(value.Ref) && !pseudo.has(value.Ref)) fail(`dangling Ref ${value.Ref} at ${path}`);
    const getAtt = value["Fn::GetAtt"];
    if (Array.isArray(getAtt) && typeof getAtt[0] === "string" && !resources.has(getAtt[0])) fail(`dangling GetAtt ${getAtt[0]} at ${path}`);
  });
  for (const [name, resource] of Object.entries(template.Resources ?? {})) {
    const dependencies = typeof resource.DependsOn === "string" ? [resource.DependsOn] : resource.DependsOn ?? [];
    for (const dependency of dependencies) if (!resources.has(dependency)) fail(`${name} has dangling DependsOn ${dependency}`);
  }
}

export async function loadReadingProductionTemplate(url = templateUrl) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function validateReadingProductionTemplate(template) {
  if (template.AWSTemplateFormatVersion !== "2010-09-09") fail("unexpected template version");
  if (template.Parameters?.Environment?.Default !== "production" || text(template.Parameters.Environment.AllowedValues) !== '["production"]') fail("environment must be fixed to production");
  if (text(template.Parameters?.AllowedOrigins?.Default) !== '"https://www.nana-fortune.com"') fail("production origin must be exact");
  for (const name of ["ReadingGenerateApiEnabled", "ReadingAsyncPaidEnabled", "ReadingStatusApiEnabled", "ReadingBedrockEnabled", "WorkerEventSourceMappingsEnabled", "ReadingLightQuotaEnabled", "MembershipStatusApiEnabled"]) {
    if (template.Parameters?.[name]?.Default !== "false") fail(`${name} must fail closed`);
  }
  const serialized = text(template);
  for (const forbidden of ["staging", "/user/status", "fincode/test", "FincodeWebhook", "BEDROCK_MODEL_ID", "global.", "overwrite:path", "READING_DEEP_GENERATE_API_ENABLED"]) {
    if (serialized.toLowerCase().includes(forbidden.toLowerCase())) fail(`forbidden token: ${forbidden}`);
  }
  let nullCount = 0;
  visit(template, (value) => { if (value === null) nullCount += 1; });
  if (nullCount !== 0) fail("template contains null values");

  const expectedCounts = {
    "AWS::DynamoDB::Table": 5,
    "AWS::SQS::Queue": 4,
    "AWS::Logs::LogGroup": 5,
    "AWS::IAM::Role": 5,
    "AWS::Lambda::Function": 5,
    "AWS::Lambda::EventSourceMapping": 2,
    "AWS::ApiGatewayV2::Api": 1,
    "AWS::ApiGatewayV2::Integration": 3,
    "AWS::ApiGatewayV2::Route": 3,
    "AWS::ApiGatewayV2::Stage": 1,
    "AWS::Lambda::Permission": 3,
    "AWS::CloudWatch::Alarm": 7,
  };
  const values = Object.values(template.Resources ?? {});
  for (const [type, expected] of Object.entries(expectedCounts)) {
    const actual = values.filter((resource) => resource.Type === type).length;
    if (actual !== expected) fail(`${type} expected ${expected}, received ${actual}`);
  }
  for (const forbiddenResource of ["ReadingUsersTable", "ReadingHistoryTable", "StagingLoginFunction", "StagingSignupFunction", "StagingMembershipStatusFunction", "FincodeWebhookFunction"]) {
    if (template.Resources?.[forbiddenResource]) fail(`forbidden resource ${forbiddenResource}`);
  }
  if (!template.Parameters?.UsersTableArn || !template.Parameters?.HistoryTableArn || !template.Parameters?.RuntimeSecretsArn) fail("external production source-of-truth parameters are missing");

  for (const [name, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type === "AWS::IAM::Role") {
      for (const statement of statements(template, name)) {
        if (statement.Resource === "*" || (Array.isArray(statement.Resource) && statement.Resource.includes("*"))) fail(`${name} contains wildcard resource`);
        if (actions(statement).includes("iam:PassRole") || actions(statement).includes("dynamodb:Scan")) fail(`${name} contains forbidden action`);
      }
    }
    if (resource.Type === "AWS::Lambda::Function") {
      if (Object.hasOwn(resource.Properties ?? {}, "ReservedConcurrentExecutions")) fail(`${name} must use the temporary shared unreserved concurrency pool`);
      const env = resource.Properties?.Environment?.Variables ?? {};
      if (text(env.RUNTIME_ENVIRONMENT) !== text({ Ref: "Environment" })) fail(`${name} production runtime boundary`);
    }
  }

  const request = statements(template, "ReadingRequestRole");
  if (!request.some((statement) => actions(statement).includes("sqs:SendMessage"))) fail("request cannot enqueue");
  if (request.some((statement) => actions(statement).some((action) => String(action).startsWith("bedrock:")))) fail("request can invoke Bedrock");
  const statusActions = statements(template, "ReadingStatusRole").flatMap(actions);
  if (statusActions.some((action) => action !== "logs:CreateLogStream" && action !== "logs:PutLogEvents" && action !== "dynamodb:GetItem")) fail("status role is not read-only");
  const membership = statements(template, "MembershipStatusRole");
  const membershipActions = membership.flatMap(actions);
  if (membershipActions.some((action) => action !== "logs:CreateLogStream" && action !== "logs:PutLogEvents" && action !== "dynamodb:GetItem")) fail("membership role is not read-only");
  const membershipRead = membership.find((statement) => actions(statement).includes("dynamodb:GetItem"));
  if (text(membershipRead?.Resource) !== text([{ Ref: "UsersTableArn" }, { "Fn::GetAtt": ["FincodeLightQuotaTable", "Arn"] }, { "Fn::GetAtt": ["ReadingDeepQuotaTable", "Arn"] }])) fail("membership table scope");

  for (const mode of ["Light", "Deep"]) {
    const worker = statements(template, `${mode}WorkerRole`);
    const queue = worker.find((statement) => actions(statement).includes("sqs:ReceiveMessage"));
    if (text(queue?.Resource) !== text({ "Fn::GetAtt": [`${mode}Queue`, "Arn"] })) fail(`${mode} worker queue scope`);
    const directProfile = worker.find((statement) => actions(statement).includes("bedrock:InvokeModel") && !statement.Condition);
    if (text(directProfile?.Resource) !== text({ Ref: `${mode}InferenceProfileArn` })) fail(`${mode} inference profile scope`);
    const foundationModels = worker.find((statement) => actions(statement).includes("bedrock:InvokeModel") && statement.Condition);
    if (text(foundationModels?.Resource) !== text([{ Ref: `${mode}TokyoFoundationModelArn` }, { Ref: `${mode}OsakaFoundationModelArn` }])) fail(`${mode} foundation model scope`);
    if (text(template.Resources[`${mode}EventSourceMapping`].Properties.Enabled) !== text({ "Fn::If": ["WorkersEnabled", true, false] })) fail(`${mode} worker kill switch`);
  }

  const routes = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route").map((resource) => resource.Properties.RouteKey).sort();
  assert.deepEqual(routes, ["GET /membership/status", "GET /reading/status", "POST /reading"]);
  if (template.Resources.ReadingHttpApi.Properties.CorsConfiguration.AllowOrigins?.Ref !== "AllowedOrigins") fail("CORS origin source");
  if (text(template.Resources.ReadingHttpApi.Properties.CorsConfiguration.AllowHeaders) !== text(["authorization", "content-type", "idempotency-key"])) fail("CORS headers");
  validateReferences(template);
  return true;
}

export async function validateGeneratedProductionTemplate() {
  const stored = await loadReadingProductionTemplate();
  const generated = await createProductionTemplate();
  if (text(stored) !== text(generated)) fail("stored template does not match generator output");
  return validateReadingProductionTemplate(stored);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await validateGeneratedProductionTemplate();
  process.stdout.write("READING_PRODUCTION_IAC_LOCAL_VALIDATE: PASS\n");
}
