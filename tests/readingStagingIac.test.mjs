import assert from "node:assert/strict";
import test from "node:test";
import { loadReadingStagingTemplate, validateReadingStagingTemplate } from "../scripts/validate-reading-staging-iac.mjs";

function clone(value) {
  return structuredClone(value);
}

test("staging IaCは構成・timeout・分離境界を満たす", async () => {
  assert.equal(validateReadingStagingTemplate(await loadReadingStagingTemplate()), true);
});

test("HTTP APIの明示名が欠落したtemplateを拒否する", async () => {
  const template = clone(await loadReadingStagingTemplate());
  delete template.Resources.ReadingHttpApi.Properties.Name;
  assert.throws(() => validateReadingStagingTemplate(template), /HTTP API name must be stack scoped/u);
});

test("公開/reading pathをintegrationで書き換えるtemplateを拒否する", async () => {
  const template = clone(await loadReadingStagingTemplate());
  template.Resources.ReadingRequestIntegration.Properties.RequestParameters = {
    "overwrite:path": "'/reading/generate'",
  };
  assert.throws(() => validateReadingStagingTemplate(template), /public \/reading path must not be rewritten/u);
});

test("status roleへのwrite/SQS/Bedrock権限追加を拒否する", async () => {
  const template = clone(await loadReadingStagingTemplate());
  template.Resources.ReadingStatusRole.Properties.Policies[0].PolicyDocument.Statement.push({
    Effect: "Allow",
    Action: "dynamodb:UpdateItem",
    Resource: { "Fn::GetAtt": ["ReadingJobsTable", "Arn"] },
  });
  assert.throws(() => validateReadingStagingTemplate(template), /status role is not read-only/u);
});

test("request roleへのBedrock権限追加を拒否する", async () => {
  const template = clone(await loadReadingStagingTemplate());
  template.Resources.ReadingRequestRole.Properties.Policies[0].PolicyDocument.Statement.push({
    Effect: "Allow",
    Action: "bedrock:InvokeModel",
    Resource: { Ref: "LightInferenceProfileArn" },
  });
  assert.throws(() => validateReadingStagingTemplate(template), /request role can invoke Bedrock/u);
});

test("wildcard resourceとGlobal profileを拒否する", async () => {
  const wildcard = clone(await loadReadingStagingTemplate());
  wildcard.Resources.LightWorkerRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource = "*";
  assert.throws(() => validateReadingStagingTemplate(wildcard), /wildcard resource/u);

  const globalProfile = clone(await loadReadingStagingTemplate());
  globalProfile.Parameters.LightModelId.Default = "global.example";
  assert.throws(() => validateReadingStagingTemplate(globalProfile), /forbidden token: global\./u);
});

test("機能flagのdefault true化を拒否する", async () => {
  const template = clone(await loadReadingStagingTemplate());
  template.Parameters.ReadingStatusApiEnabled.Default = "true";
  assert.throws(() => validateReadingStagingTemplate(template), /must fail closed/u);
});

test("fincode Webhookはstaging限定・既定OFF・最小権限である", async () => {
  const template = await loadReadingStagingTemplate();
  assert.equal(template.Parameters.FincodeWebhookEnabled.Default, "false");
  assert.equal(template.Parameters.FincodePeriodSourceEnabled.Default, "false");
  assert.equal(template.Parameters.FincodeProvisionalTestPeriodSourceEnabled.Default, "false");
  assert.equal(template.Parameters.FincodeOneTimeVoiceWebhookEnabled.Default, "false");
  assert.equal(template.Parameters.ReadingLightQuotaEnabled.Default, "false");
  assert.equal(template.Resources.FincodeWebhookFunction.Properties.Runtime, "nodejs22.x");
  assert.equal(template.Resources.FincodeWebhookRoute.Properties.RouteKey, "POST /webhooks/fincode");
  assert.equal(template.Resources.FincodeWebhookRoute.Properties.AuthorizationType, "NONE");
  assert.equal(template.Resources.FincodeWebhookRoute.Properties.ApiId.Ref, "FincodeWebhookHttpApi");
  assert.equal(template.Resources.FincodeWebhookHttpApi.Properties.CorsConfiguration, undefined);
  assert.equal(template.Resources.FincodeWebhookIntegration.Properties.TimeoutInMillis, 15000);
  assert.equal(template.Resources.FincodeWebhookFunction.Properties.Timeout, 15);
  assert.equal(template.Resources.FincodeWebhookFunction.Properties.Environment.Variables.FINCODE_WEBHOOK_INTERNAL_DEADLINE_MS, "14000");
  assert.equal(template.Resources.FincodeOneTimeVoicePurchaseTable.DeletionPolicy, "Retain");
  const serialized = JSON.stringify(template.Resources.FincodeWebhookRole);
  assert.doesNotMatch(serialized, /dynamodb:Scan|dynamodb:BatchWriteItem|sqs:|bedrock:|iam:/u);
  assert.match(serialized, /secretsmanager:GetSecretValue/u);
  const webhookStatements = template.Resources.FincodeWebhookRole.Properties.Policies[0].PolicyDocument.Statement;
  const bySid = (sid) => webhookStatements.find((statement) => statement.Sid === sid);
  assert.deepEqual(bySid("CompleteWebhookMembership"), {
    Sid: "CompleteWebhookMembership", Effect: "Allow",
    Action: ["dynamodb:ConditionCheckItem", "dynamodb:UpdateItem"],
    Resource: { "Fn::GetAtt": ["ReadingUsersTable", "Arn"] },
  });
  assert.deepEqual(bySid("CompleteWebhookLightQuota"), {
    Sid: "CompleteWebhookLightQuota", Effect: "Allow",
    Action: ["dynamodb:ConditionCheckItem", "dynamodb:PutItem"],
    Resource: { "Fn::GetAtt": ["FincodeLightQuotaTable", "Arn"] },
  });
  assert.deepEqual(bySid("CompleteOneTimeVoiceAtomically"), {
    Sid: "CompleteOneTimeVoiceAtomically", Effect: "Allow", Action: "dynamodb:UpdateItem",
    Resource: [{ "Fn::GetAtt": ["FincodeOneTimeVoicePurchaseTable", "Arn"] }, { "Fn::GetAtt": ["ReadingUsersTable", "Arn"] }],
  });
  assert.doesNotMatch(serialized, /dynamodb:TransactWriteItems/u);
});
