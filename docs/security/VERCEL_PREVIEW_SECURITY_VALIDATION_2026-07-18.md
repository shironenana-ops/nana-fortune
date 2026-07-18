# Vercel Preview security validation — 2026-07-18

## 結論

`BLOCKED_BY_PREVIEW_PROTECTION`

指定されたVercel PreviewはVercel SSO／Preview Protectionで保護されており、認証なしではアプリ本体の挙動を観測できなかった。保護解除、bypass secretの探索・使用、redirect追従は行っていない。この結果はpath override修正のPASSまたはFAILを示すものではない。

## 対象と安全判定

- 対象種別：ユーザーが明示した`*.vercel.app` Preview
- URL構文・host制約：PASS
- target hostname：SHA-256だけを証跡へ保存
- production hostnameの事前拒否：有効
- productionへのrequest：0
- redirect追従：0
- AWS／Bedrock／DynamoDB実行：0
- 実token／実鑑定入力：不使用
- `READING_DEEP_GENERATE_API_ENABLED`：未設定

## 外部観測

- 実施日時：2026-07-18 16:59 JST
- 最初の`GET /about`：Vercel SSOへの302を観測
- POST：認証層から401を観測
- Preview Protection：検出
- 本番redirect：未検出
- 匿名request総数：18
- response本文の保存：なし
- Cookie、Set-Cookie、認証情報、redirect query、nonce、request IDの保存：なし

最初の302を旧probeが即時停止条件として認識できず、匿名の後続requestが送信された。いずれもProtection層で遮断され、production redirectには追従していない。検出漏れはローカルで修正し、Vercel SSOへの302を1 requestで安全停止する回帰テストを追加した。Protectionを回避する再実行はしていない。

## Path override matrix

| ID | 検証 | 結果 |
|---|---|---|
| PO-01 | GET header | NOT_EVALUATED — Protection層の応答 |
| PO-02 | POST header | NOT_EVALUATED — Protection層の応答 |
| PO-03 | GET query | NOT_EVALUATED — Protection層の応答 |
| PO-04 | POST query | NOT_EVALUATED — Protection層の応答 |

Protection層の同一応答をアプリの修正確認として採用していない。

## Smoke test

主要ページ、MDX、RSS、sitemap、画像、404、認証関連画面はすべて`BLOCKED_BY_PREVIEW_PROTECTION`。アプリ本体へ到達していないため、正常性を評価していない。

## ローカル回帰

Phase Bの保護検出修正後に次を再実行した。

- `npm test`：115 pass / 0 fail / 0 skipped
- Node.js 22.23.1：115 pass / 0 fail / 0 skipped
- `npm run build`：PASS
- TypeScript 5.9.3 `tsc --noEmit`：PASS
- `npm audit --omit=dev`：total 8 / critical 0 / high 4 / moderate 1 / low 3（依存変更なし）
- `git diff --check`：PASS

## 保存した証跡

- `docs/security/evidence/vercel-preview-path-override-2026-07-18.json`
- 本文、Preview hostname、redirect URL、nonce、Vercel request IDを含めていない。

## 残る確認

Protectionを維持したまま認証済みの安全な検証経路が別途明示されない限り、Preview上のpath overrideとsmokeは確認不能。設定変更や保護解除は本作業の範囲外である。
