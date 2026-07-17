# 鑑定サーバー境界の移行計画

## 1. 実行方式比較

| 案 | 再利用 | 運用・認証 | 長所 | 主なリスク | 評価 |
|---|---|---|---|---|---|
| A Astro/Vercel API | TSを直接再利用 | VercelへAWS資格情報とtoken secretが必要 | Webと同時配備、ローカル容易 | 秘密・AWS権限が二基盤、障害切分け | 次点 |
| B Node.js AWS Lambda | TSをビルドして再利用 | 既存API Gateway/Lambda/DynamoDBと同一境界 | IAM、DynamoDB、監査を集約 | Nodeビルド・正式デプロイ方式が未整備 | 推奨候補 |
| C Python移植 | 再利用不可 | 既存Pythonと同居 | 実行基盤は馴染む | 二重実装、結果差、修正漏れ | 不採用 |
| D free client、有料server | 有料のみserver | 段階導入しやすい | 早い、無料障害を避ける | 履歴・ロジック経路が一時分裂 | 移行段階として採用 |
| E 全mode server | TS serverを統一 | 単一境界 | 履歴・権限・監査が単純 | 未ログイン負荷、コスト、障害でfree停止 | 最終候補、別判断 |

第一候補はBを基盤に、移行中はDです。根拠は、既存の認証付きAPI・users・historyがAWS Lambda/API Gateway/DynamoDB上にあり、IAMでDBアクセスを絞れること、TypeScript engineをPythonへ複製せず再利用できることです。

ただしリポジトリ内にIaC、Node Lambdaのbuild/deploy、API Gateway定義はありません。実際のデプロイ方式、runtime、secret配布、ロールバック手段を確認するまでBを最終確定・実装しません。

## 2. PR分割

| PR | 目的・変更 | 依存 | 開放 | テスト | ロールバック |
|---|---|---|---|---|---|
| 1 | Node server engine build、clientと同一fixture | なし | なし | free/light/deep決定性一致 | artifactを未参照化 |
| 2 | token検証、users取得、allow-list CORS共通部 | 1 | なし | 期限・署名・Origin・DTO | route無効化 |
| 3 | `/reading/generate`契約と入力・mode判定 | 2 | なし | 権限表、改ざん、入力上限 | route無効化 |
| 4 | 冪等性＋サーバー履歴保存 | 3 | なし | 並列、再送、失敗注入 | 新経路停止、旧free維持 |
| 5 | ログイン済みfreeをAPIへ接続 | 4 | free一部 | E2E、履歴互換 | feature flagでclientへ |
| 6 | lightを限定β接続 | 5 | β light | entitlement、負荷、履歴 | flag OFF、準備中へ |
| 7 | deep権利スキーマ・予約・確定・解放 | 人間仕様 | なし | transaction、回収、二重処理 | deep route無効化 |
| 8 | deep限定β接続 | 7 | β deep | 並列・失敗・権利補償 | flag OFF |
| 9 | 旧client有料生成コードと任意本文保存を制限 | 6,8 | 一般有料候補 | 直接HTTP・DevTools | 直前artifactへ戻す |
| 10 | 未ログインfree統一を評価・移行 | 運用判断 | free | IP制限、DoS、障害 | client free維持 |

## 3. β開放条件

安全水準Bだけのβは、隔離したtest環境、架空データ、無課金、少人数、結果を正式商品として扱わない場合のみ許容候補です。陽子さん等の特定人物をコードへハードコードせず、テスト用アカウント・環境・feature flagで制御します。

実会員データ・実課金・正式履歴を使うβは境界C、冪等性、Origin制限、監査ログ、停止スイッチが必要です。

## 4. 本番開放条件

- [PAID_READING_TRUST_BOUNDARY.md](./PAID_READING_TRUST_BOUNDARY.md)の境界C条件を満たす
- [READING_API_CONTRACT.md](./READING_API_CONTRACT.md)の契約テスト成功
- [READING_IDEMPOTENCY_AND_ENTITLEMENT.md](./READING_IDEMPOTENCY_AND_ENTITLEMENT.md)の並列・失敗試験成功
- free/light/deepのserver/client fixture一致
- 認証、CORS、入力上限、rate limit、監査ログの第三者レビュー
- deep単発権利と補償運用を人間が承認
- 旧任意本文保存APIを有料経路から遮断

## 5. レート制限案

| mode | user制限 | IP制限 | 追加防御 |
|---|---|---|---|
| 未ログインfree | 不可 | 短時間＋日次 | CAPTCHA候補、履歴なし、厳しいbody上限 |
| ログインfree | 短時間＋日次 | 補助 | Idempotency-Key、履歴件数監視 |
| light | 契約user単位 | 補助 | 同時1件、processing lease |
| deep | 権利＋user単位 | 補助 | 同時1件、予約必須、より長いcooldown |

具体値は実測レイテンシ、Lambda同時実行枠、DynamoDB容量、商品仕様がないため未確定です。engineは外部生成APIを呼ばない決定的ローカル計算ですが、履歴書込みと大量結果生成はコスト・容量リスクになります。

## 6. 観測と監査

記録：request_id、history_id、ローテーション可能な鍵でHMAC化したuser識別子、requested/resolved mode、entitlement結果コード、冪等結果、状態遷移、エラーコード、処理時間、deploy/engine version。

禁止：token、SESSION_TOKEN_SECRET、生年月日、相談全文、メール全文、AWS秘密、MOSH/fincode情報、鑑定本文全文。アプリログと利用者履歴を分離し、ログ保持期間と閲覧権限を設定します。

## 7. ロールバック

1. mode別feature flagをOFFにし、準備中画面へ戻す。
2. API routeを無効化して新規受付を停止する。
3. processingを増やさず、既存leaseを監査する。
4. completed履歴は削除せず閲覧可能に保つ。
5. 未確定予約を期限・監査ログで解放する。
6. 直前のLambda artifact/configへ戻す。具体的手順は既存デプロイ方式確認後に追記する。

## 8. 未確定事項と人間判断

- Node Lambdaのbuild/deploy/IaC、runtime、artifact保管、alias/rollback方式
- users/historyテーブルの正式キー・GSI・容量・TTL方針
- deep単発権利の項目、残数、期限、返金、予約、消費単位
- 月額deepを無制限とするか、rate limit以外の回数制を持つか
- TransactWriteItems対象を同一アカウント・リージョンで構成できるか
- light/deepの正式なhistory type/source/reading_modeと旧画面互換性
- failed/processingを利用者履歴へ表示するか、内部テーブルへ分けるか
- 未ログインfreeをserverへ移す時期とDoS対策
- 入力上限、履歴保持、冪等記録保持、ログ保持の期間
- βで実データ・実課金を使うか

これらは推測でスキーマや運用へ反映しません。
