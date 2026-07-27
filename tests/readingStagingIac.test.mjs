import assert from "node:assert/strict";
import test from "node:test";
import { loadReadingStagingTemplate, validateReadingStagingTemplate } from "../scripts/validate-reading-staging-iac.mjs";

function clone(value) {
  return structuredClone(value);
}

test("staging IaCは構成・timeout・分離境界を満たす", async () => {
  assert.equal(validateReadingStagingTemplate(await loadReadingStagingTemplate()), true);
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
