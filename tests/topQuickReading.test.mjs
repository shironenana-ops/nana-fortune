import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transform } from "esbuild";

async function compileModule(sourcePath, replacements = {}) {
  const source = fs.readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  const compiled = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022"
  });
  let code = compiled.code;

  for (const [specifier, replacement] of Object.entries(replacements)) {
    code = code.replaceAll(specifier, replacement);
  }

  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

const shironeTypesUrl = await compileModule("../src/lib/shironeTypes.ts");
const topQuickReadingUrl = await compileModule("../src/lib/topQuickReading.ts", {
  "./shironeTypes": shironeTypesUrl
});
const { getShironeTypeByBirthDate } = await import(shironeTypesUrl);
const { buildTopQuickReading, TopQuickReadingValidationError } =
  await import(topQuickReadingUrl);

const fixedToday = new Date(2026, 6, 17, 12, 0, 0);
const validBirthday = "1990-04-15";

function expectValidationError(birthday, messagePattern) {
  assert.throws(
    () => buildTopQuickReading({ birthday }, fixedToday),
    (error) => {
      assert.ok(error instanceof TopQuickReadingValidationError);
      assert.equal(error.field, "birthday");
      assert.match(error.message, messagePattern);
      return true;
    }
  );
}

test("有効な生年月日から属性中心の結果を生成できる", () => {
  const result = buildTopQuickReading({ birthday: validBirthday }, fixedToday);

  assert.ok(result.typeId);
  assert.ok(result.typeName);
  assert.ok(result.icon);
  assert.ok(result.identitySummary.length >= 2);
  assert.ok(result.identitySummary.every(Boolean));
  assert.ok(result.strengths);
  assert.ok(result.guidance);
  assert.ok(result.cautions);
});

test("相が存在する属性では既存の相を返す", () => {
  const existing = getShironeTypeByBirthDate(validBirthday);
  const result = buildTopQuickReading({ birthday: validBirthday }, fixedToday);

  assert.ok(existing);
  assert.equal(result.phaseName, existing.phase?.label ?? "");
  if (existing.phase) assert.ok(result.phaseName);
});

test("同じ生年月日では同じ属性結果になる", () => {
  const expected = buildTopQuickReading({ birthday: validBirthday }, fixedToday);

  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(buildTopQuickReading({ birthday: validBirthday }, fixedToday), expected);
  }
});

test("既存のgetShironeTypeByBirthDateと結果が一致する", () => {
  const existing = getShironeTypeByBirthDate(validBirthday);
  const result = buildTopQuickReading({ birthday: validBirthday }, fixedToday);

  assert.ok(existing);
  assert.equal(result.typeId, existing.slug);
  assert.equal(result.typeName, existing.typeName);
  assert.equal(result.icon, existing.icon);
  assert.equal(result.strengths, existing.strengths);
  assert.equal(result.cautions, existing.weakness);
});

test("名前と日運の値を入力にも結果にも持たない", () => {
  const result = buildTopQuickReading({ birthday: validBirthday }, fixedToday);
  const forbiddenKeys = [
    "name",
    "nameNumber",
    "theme",
    "personalDay",
    "zodiac",
    "lifePath",
    "recommendedActions"
  ];

  for (const key of forbiddenKeys) {
    assert.equal(Object.hasOwn(result, key), false);
  }
});

test("無効な生年月日を拒否する", () => {
  expectValidationError("1990-02-30", /実在/);
  expectValidationError("1899-12-31", /1900年/);
  expectValidationError("2026-07-18", /未来/);
});

test("TOP用アダプターは日運・Storage・通信・APIへ依存しない", () => {
  const source = fs.readFileSync(
    new URL("../src/lib/topQuickReading.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /buildDailyFortune|runShironeEngine/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest/);
  assert.doesNotMatch(source, /history|users|billing|voice|https?:\/\//i);
});
