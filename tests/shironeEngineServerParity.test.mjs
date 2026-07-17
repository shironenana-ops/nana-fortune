import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { buildReadingEngine } from "../scripts/build-reading-engine.mjs";

const fixtureUrl = new URL("./fixtures/shironeEngine/parity-inputs.json", import.meta.url);
const fixtures = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
const engineSource = fs.readFileSync(new URL("../src/lib/shironeEngine.ts", import.meta.url), "utf8");
const compiledBrowserModule = await transform(engineSource, {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
const browserModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledBrowserModule.code).toString("base64")}`;
const { runShironeEngine: runBrowserEngine } = await import(browserModuleUrl);

const buildResult = await buildReadingEngine();
const serverArtifactUrl = new URL("../dist/reading-engine/index.mjs", import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRunner = fileURLToPath(
  new URL("../scripts/run-reading-engine-fixture.mjs", import.meta.url),
);
const serverArtifact = fs.readFileSync(serverArtifactUrl, "utf8");
const { runShironeEngineOnServer } = await import(`${serverArtifactUrl.href}?test=${Date.now()}`);

function runInSeparateProcess(input, timezone) {
  const result = spawnSync(
    process.execPath,
    [fixtureRunner],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, TZ: timezone },
      input: JSON.stringify(input),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("free・light・deepを同じ共通エンジンからサーバー実行できる", () => {
  assert.deepEqual(new Set(fixtures.map(({ input }) => input.plan)), new Set(["free", "light", "deep"]));
  for (const { input } of fixtures) {
    assert.doesNotThrow(() => runShironeEngineOnServer(input));
  }
});

test("ブラウザ通常import相当とサーバー成果物がfixture単位で完全一致する", () => {
  for (const { id, input } of fixtures) {
    const browserResult = runBrowserEngine(input);
    const serverResult = runShironeEngineOnServer(input);
    assert.deepEqual(serverResult, browserResult, id);
    assert.equal(JSON.stringify(serverResult), JSON.stringify(browserResult), id);
  }
});

test("同一入力は実行回数と順序を変えても完全一致する", () => {
  const expected = new Map(fixtures.map(({ id, input }) => [id, runShironeEngineOnServer(input)]));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const { id, input } of [...fixtures].reverse()) {
      assert.deepEqual(runShironeEngineOnServer(input), expected.get(id), `${id}:${attempt}`);
    }
  }
});

test("別Node.jsプロセスとタイムゾーン差でも固定日fixtureが一致する", () => {
  for (const { id, input } of fixtures) {
    const expected = runShironeEngineOnServer(input);
    assert.deepEqual(runInSeparateProcess(input, "UTC"), expected, `${id}:UTC`);
    assert.deepEqual(runInSeparateProcess(input, "Asia/Tokyo"), expected, `${id}:Asia/Tokyo`);
    assert.deepEqual(runInSeparateProcess(input, "America/New_York"), expected, `${id}:New_York`);
  }
});

test("サーバー成果物は単一共通エンジンだけをbundleし禁止依存を持たない", () => {
  const inputs = Object.keys(buildResult.metafile.inputs).map((value) => value.replaceAll("\\", "/"));
  assert.deepEqual(inputs.sort(), [
    "src/lib/shironeEngine.ts",
    "src/server/shironeEngineServer.ts",
  ]);
  assert.doesNotMatch(
    serverArtifact,
    /\b(window|document|localStorage|sessionStorage|navigator|location|HTMLElement|DOMParser)\b|\bPUBLIC_[A-Z0-9_]+\b|astro\/client|@vite\/client/i,
  );
  assert.doesNotMatch(
    serverArtifact,
    /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_|gho_|\btoken\b|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|test-user/i,
  );
});

test("固定入力は実在利用者情報とメールアドレスを含まない", () => {
  const text = fs.readFileSync(fixtureUrl, "utf8");
  assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.match(text, /架空/);
});
