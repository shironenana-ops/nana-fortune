import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transform } from "esbuild";

const source = fs.readFileSync(new URL("../src/lib/shironeEngine.ts", import.meta.url), "utf8");
const compiled = await transform(source, {
  loader: "ts",
  format: "esm",
  target: "es2022"
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
const { runShironeEngine } = await import(moduleUrl);

const fixtures = [
  { name: "架空 花子", birthDate: "1990-04-15" },
  { name: "架空 太郎", birthDate: "1985-11-03" },
  { name: "テスト 三郎", birthDate: "2001-07-22" }
];
const startDate = new Date(Date.UTC(2026, 0, 1));

function dateAfter(days) {
  const date = new Date(startDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function generate(fixture, day) {
  return runShironeEngine({
    ...fixture,
    today: dateAfter(day),
    plan: "free"
  });
}

function structureKey(result) {
  return result.sections.map((section) => section.title).join("|");
}

test("同一入力・同一日は10回生成しても完全一致する", () => {
  for (const fixture of fixtures) {
    const expected = generate(fixture, 12);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.deepEqual(generate(fixture, 12), expected);
    }
  }
});

test("架空3条件すべてで30日以内に3構成が出現する", () => {
  for (const fixture of fixtures) {
    const structures = new Set(
      Array.from({ length: 30 }, (_, day) => structureKey(generate(fixture, day)))
    );

    assert.equal(structures.size, 3);
  }
});

test("90日分布に極端な偏りがなく、追加セクションの組み合わせが増える", (context) => {
  for (const fixture of fixtures) {
    const results = Array.from({ length: 90 }, (_, day) => generate(fixture, day));
    const structureCounts = new Map();
    let longestRun = 0;
    let currentRun = 0;
    let previousStructure = "";
    let shortestRepeat = null;
    const lastSeenResult = new Map();

    for (const [day, result] of results.entries()) {
      const key = structureKey(result);
      const resultKey = JSON.stringify(result.sections);
      structureCounts.set(key, (structureCounts.get(key) ?? 0) + 1);
      currentRun = key === previousStructure ? currentRun + 1 : 1;
      longestRun = Math.max(longestRun, currentRun);
      previousStructure = key;

      if (lastSeenResult.has(resultKey)) {
        const gap = day - lastSeenResult.get(resultKey);
        shortestRepeat = shortestRepeat === null ? gap : Math.min(shortestRepeat, gap);
      }
      lastSeenResult.set(resultKey, day);
    }

    const counts = [...structureCounts.values()];
    const uniqueResults = new Set(results.map((result) => JSON.stringify(result.sections))).size;
    assert.equal(structureCounts.size, 3);
    assert.ok(Math.min(...counts) >= 20);
    assert.ok(Math.max(...counts) <= 40);
    assert.ok(uniqueResults >= 70);
    assert.ok(longestRun <= 4);

    context.diagnostic(JSON.stringify({
      fixture: fixture.name,
      structureCounts: Object.fromEntries(structureCounts),
      uniqueResults,
      longestRun,
      shortestRepeat
    }));
  }
});

test("無料版セクションの返却形状と文面が有効である", () => {
  for (const fixture of fixtures) {
    for (let day = 0; day < 90; day += 1) {
      const result = generate(fixture, day);
      assert.equal(result.sections.length, 3);
      assert.equal(new Set(result.sections.map((section) => section.title)).size, 3);
      assert.equal(new Set(result.sections.map((section) => section.body)).size, 3);

      for (const section of result.sections) {
        assert.ok(["today-line", "margin", "one-step"].includes(section.id));
        assert.equal(typeof section.title, "string");
        assert.equal(typeof section.summary, "string");
        assert.equal(typeof section.body, "string");
        assert.ok(section.title.trim());
        assert.ok(section.summary.trim());
        assert.ok(section.body.trim());
        assert.doesNotMatch(section.body, /undefined|\[object Object\]/);
      }
    }
  }
});
