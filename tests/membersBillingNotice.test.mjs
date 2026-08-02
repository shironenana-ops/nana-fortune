import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing review notice uses one full-width banner instead of a sparse card grid", async () => {
  const source = await readFile(new URL("../src/pages/members.astro", import.meta.url), "utf8");
  assert.match(source, /plan-card--billing-notice/u);
  assert.match(source, /grid-column: 1 \/ -1/u);
  assert.match(source, /flex-direction: row/u);
  assert.match(source, /@media \(max-width: 640px\)[\s\S]*plan-card--billing-notice[\s\S]*flex-direction: column/u);
  assert.match(source, /料金・プランを公開しています/u);
  assert.match(source, /料金・申込条件を見る/u);
});
