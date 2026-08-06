import assert from "node:assert/strict";
import test from "node:test";
import { createProductionTemplate } from "../scripts/generate-reading-production-iac.mjs";
import { loadReadingProductionTemplate, validateReadingProductionTemplate } from "../scripts/validate-reading-production-iac.mjs";

test("production template is generated deterministically and passes the fail-closed contract", async () => {
  const stored = await loadReadingProductionTemplate();
  const generated = await createProductionTemplate();
  assert.deepEqual(stored, generated);
  assert.equal(validateReadingProductionTemplate(stored), true);
});

test("production template reuses external canonical Users and History tables", async () => {
  const template = await loadReadingProductionTemplate();
  assert.equal(template.Resources.ReadingUsersTable, undefined);
  assert.equal(template.Resources.ReadingHistoryTable, undefined);
  assert.ok(template.Parameters.UsersTableArn);
  assert.ok(template.Parameters.HistoryTableArn);
  assert.equal(JSON.stringify(template).includes("/user/status"), false);
});

test("production paid runtime is dark by default", async () => {
  const template = await loadReadingProductionTemplate();
  for (const name of ["ReadingGenerateApiEnabled", "ReadingAsyncPaidEnabled", "ReadingStatusApiEnabled", "ReadingBedrockEnabled", "WorkerEventSourceMappingsEnabled", "ReadingLightQuotaEnabled", "MembershipStatusApiEnabled"]) {
    assert.equal(template.Parameters[name].Default, "false", name);
  }
  assert.deepEqual(template.Resources.LightEventSourceMapping.Properties.Enabled, { "Fn::If": ["WorkersEnabled", true, false] });
  assert.deepEqual(template.Resources.DeepEventSourceMapping.Properties.Enabled, { "Fn::If": ["WorkersEnabled", true, false] });
});

test("production Lambda functions temporarily share unreserved concurrency", async () => {
  const template = await loadReadingProductionTemplate();
  for (const name of ["ReadingRequestFunction", "ReadingStatusFunction", "LightWorkerFunction", "DeepWorkerFunction", "MembershipStatusFunction"]) {
    assert.equal(Object.hasOwn(template.Resources[name].Properties, "ReservedConcurrentExecutions"), false, name);
  }
});
