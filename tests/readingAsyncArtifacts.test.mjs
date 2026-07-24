import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildReadingApiHandler } from "../scripts/build-reading-api-handler.mjs";
import { buildReadingLightWorker } from "../scripts/build-reading-light-worker.mjs";
import { buildReadingDeepWorker } from "../scripts/build-reading-deep-worker.mjs";

const [requestBuild, lightBuild, deepBuild] = await Promise.all([buildReadingApiHandler(), buildReadingLightWorker(), buildReadingDeepWorker()]);

test("Node 22 ESM artifacts are mode-fixed and contain no fixture PII or secret", async () => {
  const paths = ["dist/reading-api-handler/index.mjs", "dist/reading-light-worker/index.mjs", "dist/reading-deep-worker/index.mjs"];
  for (const path of paths) {
    const text = fs.readFileSync(path, "utf8");
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_|gho_|fixture-user-private|架空 花子|1984-12-29/);
    const module = await import(`${new URL(`../${path}`, import.meta.url).href}?artifact=${Date.now()}-${path}`);
    assert.equal(typeof module.handler, "function");
    assert.deepEqual(Object.keys(module), ["handler"]);
  }
  assert.ok(Object.keys(lightBuild.metafile.inputs).some((value) => value.endsWith("readingLightWorkerLambda.ts")));
  assert.ok(!Object.keys(lightBuild.metafile.inputs).some((value) => value.endsWith("readingDeepWorkerLambda.ts")));
  assert.ok(Object.keys(deepBuild.metafile.inputs).some((value) => value.endsWith("readingDeepWorkerLambda.ts")));
  assert.ok(!Object.keys(deepBuild.metafile.inputs).some((value) => value.endsWith("readingLightWorkerLambda.ts")));
});

test("paid request artifact has no Bedrock runtime client path", () => {
  const text = fs.readFileSync("dist/reading-api-handler/index.mjs", "utf8");
  assert.doesNotMatch(text, /client-bedrock-runtime|BedrockRuntimeClient|ConverseCommand|InvokeModel/);
  assert.ok(Object.keys(requestBuild.metafile.inputs).some((value) => value.endsWith("readingLambda.ts")));
});
