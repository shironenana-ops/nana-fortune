import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = `${root}/infrastructure/reading-staging/template.json`;
const outputPath = `${root}/infrastructure/reading-production/template.json`;

const removedResourceIds = new Set([
  "ReadingUsersTable", "ReadingHistoryTable",
  "FincodeWebhookLedgerTable", "FincodeCustomerMappingTable", "FincodeOneTimeVoicePurchaseTable",
  "StagingAuthAttemptTable", "FincodeWebhookLogGroup", "FincodeWebhookRole", "FincodeWebhookFunction",
  "FincodeWebhookHttpApi", "FincodeWebhookApiStage", "FincodeWebhookIntegration", "FincodeWebhookRoute", "FincodeWebhookInvokePermission",
  "StagingLoginLogGroup", "StagingSignupLogGroup", "StagingMembershipStatusLogGroup",
  "StagingLoginRole", "StagingSignupRole", "StagingMembershipStatusRole",
  "StagingLoginFunction", "StagingSignupFunction", "StagingMembershipStatusFunction",
  "StagingLoginIntegration", "StagingSignupIntegration", "StagingMembershipStatusIntegration",
  "StagingLoginRoute", "StagingSignupRoute", "StagingMembershipStatusRoute",
  "StagingLoginInvokePermission", "StagingSignupInvokePermission", "StagingMembershipStatusInvokePermission",
]);

const removedParameterPrefixes = ["Fincode", "Staging"];
const external = {
  ReadingUsersTable: { name: "UsersTableName", arn: "UsersTableArn" },
  ReadingHistoryTable: { name: "HistoryTableName", arn: "HistoryTableArn" },
};

const unreservedConcurrencyFunctionIds = [
  "ReadingRequestFunction",
  "ReadingStatusFunction",
  "LightWorkerFunction",
  "DeepWorkerFunction",
  "MembershipStatusFunction",
];

function transform(value) {
  if (Array.isArray(value)) return value.map(transform);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.replaceAll("staging", "production").replaceAll("Staging", "Production") : value;
  }
  if (typeof value.Ref === "string" && external[value.Ref]) return { Ref: external[value.Ref].name };
  if (Array.isArray(value["Fn::GetAtt"]) && external[value["Fn::GetAtt"][0]] && value["Fn::GetAtt"][1] === "Arn") {
    return { Ref: external[value["Fn::GetAtt"][0]].arn };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transform(child)]));
}

function tags(component) {
  return [
    { Key: "Project", Value: "nana-fortune" },
    { Key: "Environment", Value: { Ref: "Environment" } },
    { Key: "Component", Value: component },
    { Key: "ManagedBy", Value: "cloudformation" },
  ];
}

function logPolicy(logicalId) {
  return { Sid: "OwnLogs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::Sub": `\${${logicalId}.Arn}:*` } };
}

function addMembershipResources(template) {
  template.Resources.MembershipStatusLogGroup = {
    Type: "AWS::Logs::LogGroup", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    Properties: { LogGroupName: { "Fn::Sub": "/aws/lambda/${AWS::StackName}-membership-status" }, RetentionInDays: 30 },
  };
  template.Resources.MembershipStatusRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
      Policies: [{ PolicyName: "membership-status-production-read-only", PolicyDocument: { Version: "2012-10-17", Statement: [
        logPolicy("MembershipStatusLogGroup"),
        { Sid: "ReadCanonicalMembershipOnly", Effect: "Allow", Action: "dynamodb:GetItem", Resource: [
          { Ref: "UsersTableArn" }, { "Fn::GetAtt": ["FincodeLightQuotaTable", "Arn"] }, { "Fn::GetAtt": ["ReadingDeepQuotaTable", "Arn"] },
        ] },
      ] } }],
      Tags: tags("membership-status-role"),
    },
  };
  template.Resources.MembershipStatusFunction = {
    Type: "AWS::Lambda::Function", DependsOn: ["MembershipStatusLogGroup"],
    Properties: {
      Runtime: "nodejs22.x", Architectures: ["arm64"], Handler: "index.handler", Timeout: 10, MemorySize: 256,
      Role: { "Fn::GetAtt": ["MembershipStatusRole", "Arn"] },
      Code: { S3Bucket: { Ref: "ArtifactBucketName" }, S3Key: { Ref: "MembershipStatusArtifactKey" } },
      Environment: { Variables: {
        RUNTIME_ENVIRONMENT: { Ref: "Environment" }, MEMBERSHIP_STATUS_API_ENABLED: { Ref: "MembershipStatusApiEnabled" },
        ALLOWED_ORIGINS: { "Fn::Join": [",", { Ref: "AllowedOrigins" }] }, USERS_TABLE_NAME: { Ref: "UsersTableName" },
        FINCODE_MEMBERSHIP_QUOTA_TABLE: { Ref: "FincodeLightQuotaTable" }, READING_DEEP_QUOTA_TABLE_NAME: { Ref: "ReadingDeepQuotaTable" },
        SESSION_TOKEN_SECRET: { "Fn::Sub": "{{resolve:secretsmanager:${RuntimeSecretsArn}:SecretString:session_token_secret}}" },
        READING_DEEP_QUOTA_HASH_SECRET: { "Fn::Sub": "{{resolve:secretsmanager:${RuntimeSecretsArn}:SecretString:reading_deep_quota_hash_secret}}" },
      } },
      Tags: tags("membership-status"),
    },
  };
  template.Resources.MembershipStatusIntegration = {
    Type: "AWS::ApiGatewayV2::Integration",
    Properties: { ApiId: { Ref: "ReadingHttpApi" }, IntegrationType: "AWS_PROXY", IntegrationMethod: "POST", PayloadFormatVersion: "2.0", TimeoutInMillis: 10000, IntegrationUri: { "Fn::GetAtt": ["MembershipStatusFunction", "Arn"] } },
  };
  template.Resources.MembershipStatusRoute = {
    Type: "AWS::ApiGatewayV2::Route",
    Properties: { ApiId: { Ref: "ReadingHttpApi" }, RouteKey: "GET /membership/status", AuthorizationType: "NONE", Target: { "Fn::Join": ["/", ["integrations", { Ref: "MembershipStatusIntegration" }]] } },
  };
  template.Resources.MembershipStatusInvokePermission = {
    Type: "AWS::Lambda::Permission",
    Properties: { Action: "lambda:InvokeFunction", FunctionName: { Ref: "MembershipStatusFunction" }, Principal: "apigateway.amazonaws.com", SourceArn: { "Fn::Sub": "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ReadingHttpApi}/${Environment}/GET/membership/status" } },
  };
}

function addAlarms(template) {
  const alarm = (name, metric, dimensionName, dimensionValue) => ({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmDescription: `${name} production safety alarm`, Namespace: metric.namespace, MetricName: metric.name,
      Dimensions: [{ Name: dimensionName, Value: dimensionValue }], Statistic: "Sum", Period: 300, EvaluationPeriods: 1,
      Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
      Tags: tags(name),
    },
  });
  template.Resources.LightDlqAlarm = alarm("light-dlq", { namespace: "AWS/SQS", name: "ApproximateNumberOfMessagesVisible" }, "QueueName", { "Fn::GetAtt": ["LightDeadLetterQueue", "QueueName"] });
  template.Resources.DeepDlqAlarm = alarm("deep-dlq", { namespace: "AWS/SQS", name: "ApproximateNumberOfMessagesVisible" }, "QueueName", { "Fn::GetAtt": ["DeepDeadLetterQueue", "QueueName"] });
  for (const id of ["ReadingRequest", "ReadingStatus", "MembershipStatus", "LightWorker", "DeepWorker"]) {
    template.Resources[`${id}ErrorAlarm`] = alarm(`${id.toLowerCase()}-errors`, { namespace: "AWS/Lambda", name: "Errors" }, "FunctionName", { Ref: `${id}Function` });
  }
}

export async function createProductionTemplate() {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const template = transform(source);
  template.Description = "Shirone canonical paid reading production infrastructure (disabled by default)";
  template.Parameters.Environment = { Type: "String", Default: "production", AllowedValues: ["production"] };
  template.Parameters.AllowedOrigins = { Type: "CommaDelimitedList", Default: "https://www.nana-fortune.com,https://nana-fortune.com", Description: "Exact production origins; wildcard is not allowed" };
  for (const name of Object.keys(template.Parameters)) {
    if (removedParameterPrefixes.some((prefix) => name.startsWith(prefix))) delete template.Parameters[name];
  }
  Object.assign(template.Parameters, {
    MembershipStatusArtifactKey: { Type: "String", MinLength: 1, MaxLength: 1024 },
    MembershipStatusApiEnabled: { Type: "String", Default: "false", AllowedValues: ["false", "true"] },
    UsersTableName: { Type: "String", Default: "shirone7_users", AllowedPattern: "^[A-Za-z0-9_.-]{3,255}$" },
    UsersTableArn: { Type: "String", AllowedPattern: "^arn:aws:dynamodb:ap-northeast-1:[0-9]{12}:table/shirone7_users$" },
    HistoryTableName: { Type: "String", Default: "shirone7_history", AllowedPattern: "^[A-Za-z0-9_.-]{3,255}$" },
    HistoryTableArn: { Type: "String", AllowedPattern: "^arn:aws:dynamodb:ap-northeast-1:[0-9]{12}:table/shirone7_history$" },
  });
  for (const id of removedResourceIds) delete template.Resources[id];
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource?.Properties?.Environment?.Variables) resource.Properties.Environment.Variables.RUNTIME_ENVIRONMENT = { Ref: "Environment" };
    if (Array.isArray(resource?.Properties?.Tags)) resource.Properties.Tags = resource.Properties.Tags.filter((tag) => tag.Key !== "Environment").concat([{ Key: "Environment", Value: { Ref: "Environment" } }]);
  }
  addMembershipResources(template);
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::IAM::Role") continue;
    const ownLogs = resource.Properties.Policies
      ?.flatMap((policy) => policy.PolicyDocument?.Statement ?? [])
      .find((statement) => statement.Sid === "OwnLogs");
    if (!ownLogs) throw new Error(`${id} OwnLogs policy is missing`);
    ownLogs.Resource = { "Fn::Sub": `\${${id.replace(/Role$/u, "LogGroup")}.Arn}:*` };
  }
  for (const id of unreservedConcurrencyFunctionIds) {
    delete template.Resources[id].Properties.ReservedConcurrentExecutions;
  }
  addAlarms(template);
  template.Outputs = {
    ReadingApiBase: { Value: { "Fn::Sub": "https://${ReadingHttpApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/${Environment}" } },
    MembershipStatusUrl: { Value: { "Fn::Sub": "https://${ReadingHttpApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/${Environment}/membership/status" } },
  };
  return template;
}

export async function writeProductionTemplate() {
  const template = await createProductionTemplate();
  await mkdir(`${root}/infrastructure/reading-production`, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return template;
}

if (process.argv.includes("--write")) await writeProductionTemplate();
