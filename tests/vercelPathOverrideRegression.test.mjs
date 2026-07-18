import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "tests", `.tmp-vercel-path-override-${process.pid}-${randomUUID()}`);
const expectedFixturePrefix = resolve(repoRoot, "tests", ".tmp-vercel-path-override-");

function write(relativePath, contents) {
  const destination = join(fixtureRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

function findFile(root, predicate) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, predicate);
      if (found) return found;
    } else if (predicate(path)) {
      return path;
    }
  }
  return undefined;
}

function assertSafeFixturePath() {
  const resolved = resolve(fixtureRoot);
  assert.ok(
    resolved.startsWith(expectedFixturePrefix),
    `refusing to remove unexpected fixture path: ${resolved}`,
  );
}

test("generated Vercel handler ignores untrusted Astro path overrides", async (t) => {
  assertSafeFixturePath();

  try {
    write(
      "astro.config.mjs",
      `import { defineConfig } from "astro/config";\nimport vercel from "@astrojs/vercel";\nexport default defineConfig({ output: "server", adapter: vercel() });\n`,
    );
    write(
      "src/pages/route-a.ts",
      `export const ALL = async ({ request }) => new Response(JSON.stringify({ marker: "route-a", method: request.method, body: await request.text() }), { headers: { "content-type": "application/json" } });\n`,
    );
    write(
      "src/pages/route-b.ts",
      `export const ALL = async ({ request }) => new Response(JSON.stringify({ marker: "route-b", method: request.method, body: await request.text() }), { headers: { "content-type": "application/json" } });\n`,
    );
    write(
      "src/pages/error.ts",
      `export const ALL = async () => { throw new Error("fixture-sensitive-error-must-not-leak"); };\n`,
    );

    execFileSync(process.execPath, [join(repoRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"], {
      cwd: fixtureRoot,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "pipe",
      timeout: 120_000,
    });

    const outputRoot = join(fixtureRoot, ".vercel", "output");
    const configPath = findFile(outputRoot, (path) => path.endsWith(".vc-config.json"));
    assert.ok(configPath, "generated Vercel function configuration was not found");
    const functionConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const handlerPath = join(dirname(configPath), functionConfig.handler);
    const generatedSourcePath = findFile(
      outputRoot,
      (path) => path.endsWith(".mjs") && readFileSync(path, "utf8").includes("x-astro-path"),
    );

    assert.ok(generatedSourcePath, "generated handler source containing Astro path handling was not found");
    const generatedSource = readFileSync(generatedSourcePath, "utf8");
    assert.match(generatedSource, /x-astro-middleware-secret/);

    const handlerModule = await import(`${pathToFileURL(handlerPath).href}?fixture=${randomUUID()}`);
    assert.equal(typeof handlerModule.default?.fetch, "function");

    const cases = [
      { name: "GET query", method: "GET", url: "https://fixture.invalid/route-a?x_astro_path=/route-b" },
      { name: "GET header", method: "GET", url: "https://fixture.invalid/route-a", headers: { "x-astro-path": "/route-b" } },
      { name: "POST query", method: "POST", url: "https://fixture.invalid/route-a?x_astro_path=/route-b", headers: { origin: "https://fixture.invalid" }, body: "post-query-body" },
      { name: "POST header", method: "POST", url: "https://fixture.invalid/route-a", headers: { origin: "https://fixture.invalid", "x-astro-path": "/route-b" }, body: "post-header-body" },
    ];

    for (const attack of cases) {
      await t.test(attack.name, async () => {
        const response = await handlerModule.default.fetch(new Request(attack.url, attack));
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.marker, "route-a");
        assert.equal(payload.method, attack.method);
        assert.notEqual(payload.marker, "route-b");
      });
    }

    const originalConsoleError = console.error;
    let errorResponse;
    try {
      console.error = () => {};
      errorResponse = await handlerModule.default.fetch(new Request("https://fixture.invalid/error"));
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(errorResponse.status, 500);
    assert.doesNotMatch(await errorResponse.text(), /fixture-sensitive-error-must-not-leak/);

    t.diagnostic(`verified generated handler: ${relative(fixtureRoot, handlerPath)}`);
  } finally {
    assertSafeFixturePath();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
