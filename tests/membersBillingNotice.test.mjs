import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing review notice uses one full-width banner instead of a sparse card grid", async () => {
  const source = await readFile(new URL("../src/pages/members.astro", import.meta.url), "utf8");
  assert.match(source, /plan-card--billing-notice/u);
  assert.match(source, /grid-column: 1 \/ -1/u);
  assert.match(source, /flex-direction: row/u);
  assert.match(source, /@media \(max-width: 640px\)[\s\S]*plan-card--billing-notice[\s\S]*flex-direction: column/u);
  assert.match(source, /3商品の申込条件を公開しています/u);
  assert.match(source, /料金・申込条件を見る/u);
  assert.match(source, /ライト会員は月額980円/u);
  assert.match(source, /プレミアム会員は月額2,980円/u);
  assert.match(source, /音声鑑定1回分は300円の買い切り/u);
  assert.doesNotMatch(source, /今後提供予定|機能準備中|現在申込不可|決済準備中/u);
});
