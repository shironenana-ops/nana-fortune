# 有料鑑定の信頼境界と脅威モデル

## 1. 結論

一般利用者へlight／deepを開放する条件は、ブラウザを信用せず、認証・会員照会・モード解決・生成・履歴確定をサーバー内で完結する「境界C」です。現状はクライアント生成と任意本文保存が残るため、本番開放不可です。

premiumの標準モードはlightです。deepはpremium、active、`deep_enabled=true`をサーバーで確認し、利用者が明示選択した場合だけ許可します。過去履歴の閲覧権限は新規生成権限と分離します。

## 2. 現在のデータフロー

```mermaid
flowchart LR
  A[/diagnosis/] -->|名前・生年月日・性別| B[localStorage fortuneInput]
  B --> C[/result/ browser]
  C -->|plan free 固定| D[shironeEngine.ts client bundle]
  D --> E[ブラウザで結果本文を生成]
  E --> F[画面表示]
  E -->|本文・type・source・時刻を送信| G[history_save.py]
  H[Bearer token] --> G
  G -->|tokenからuser_idのみ確定| I[(shirone7_history)]
  I --> J[history list/detail/delete]
```

- 未ログイン無料鑑定はブラウザ生成・画面表示まで可能です。
- ログイン済み無料鑑定も生成は同じで、保存時だけBearer tokenを使います。
- `/result`は`runShironeEngine()`へ`plan: "free"`を渡します。
- `shironeEngine.ts`のfree／light／deepコードはクライアントバンドルへ含まれます。
- 現在の保存値は`type: normal`、`source: daily_engine_v1`です。
- `history_save.py`は署名・期限・token内`user_id`、JSON形式、`history_id`存在、同一キー未登録を検証します。
- 本文、mode、type、source、status、created_at、入力サイズ、会員権限は検証しません。
- 更新はなく条件付きPutのため同一`user_id + history_id`は409ですが、別IDなら同じ結果を複数保存できます。
- 更新時は`fortuneInput`が残るため再生成できます。保存済み判定には複数のlocalStorage値も使います。

会員APIのレスポンスにはplan、`subscription_status`、`deep_enabled`等がありますが、既存画面にはlocalStorage上の識別値を使う箇所があります。`requestedMode`はまだ実行経路へ接続されていません。

## 3. 目標フロー

```mermaid
flowchart LR
  A[Browser] -->|token, input, requestedMode, Idempotency-Key| B[POST /reading/generate]
  B --> C[署名・期限検証]
  C -->|token user_id| D[(users)]
  D --> E[server entitlement]
  E --> F[server resolveReadingMode]
  F --> G[processing条件付き登録]
  G --> H[server shironeEngine]
  H --> I[履歴completed確定]
  I --> J[必要ならdeep予約を確定]
  J --> K[確定済み結果のみ返却]
```

ブラウザから信用する値は、検証済みtoken、制限内の鑑定入力、正規化前の希望mode、形式検証済みIdempotency-Keyだけです。user_id、会員属性、実行mode、履歴分類、本文、利用数、status、時刻はサーバーが決めます。

## 4. セキュリティ水準

- A UI案内：選べない項目を隠し、理由を表示する。
- B 通常操作制御：URLや通常画面操作だけでは昇格できない。
- C 強制境界：DevToolsや直接HTTPでも未権限の生成・保存・消費ができない。

βの限定検証でBを使う場合も、実データ・実課金・一般公開から隔離し、結果を有料提供しないことが条件です。本番有料提供はC必須です。

## 5. 脅威一覧

| 脅威 | 現在可能 | 影響 | 現在の防御 | 必要な防御 | 重大度 | 対応PR |
|---|---|---|---|---|---|---|
| Storage/URLでplan・mode偽装 | 部分的 | 有料mode試行 | UIと純粋解決関数 | サーバー会員照会と再解決 | High | API認証・mode判定 |
| 解決関数を迂回しengine直接実行 | 可能 | light/deep本文取得 | なし | 有料engineをサーバーのみへ | Critical | server engine、旧経路廃止 |
| premium/deep_enabled自己申告 | 保存APIでは可能 | 不正履歴 | token user_idのみ | users正本から取得 | Critical | API認証・mode判定 |
| inactiveで有料生成 | 将来接続方法次第 | 無権限利用 | 解決関数のみ | サーバーactive判定 | High | API認証・mode判定 |
| 旧Stripe属性で権限復活 | 新基盤では不可 | 誤付与 | entitlementsは不使用 | 回帰テスト維持 | Medium | APIテスト |
| 極端な入力 | 可能 | 負荷・ログ・保存肥大 | 限定的 | 長さ・形式・文字種上限 | High | API契約 |
| 連打・再送・Lambda再試行 | 可能 | 二重生成・保存・消費 | history_id重複のみ拒否 | 冪等キー＋状態機械 | Critical | idempotency |
| 完了レスポンス再利用 | 可能 | 重複表示・保存 | なし | keyに紐づく確定結果返却 | Medium | idempotency |
| 自作本文/type/source/status保存 | 可能 | 履歴偽装 | token user_id | 統合APIのみが生成・保存 | Critical | server save、旧save制限 |
| 他人user_idをbody送信 | 防御済み | 越権 | tokenのuser_idを強制 | 維持 | Low | 回帰テスト |
| 他人history_id指定 | user_id複合キーで防御 | 越権 | token user_id＋複合キー | UUID形式・所有者維持 | Low | 回帰テスト |
| processing上書き | 現saveはPut競合拒否 | 状態破損 | 同一キーPut拒否 | 条件付き状態遷移 | High | server save |
| 過去履歴の無権限再生成 | 可能 | 新規利用の迂回 | なし | 閲覧と再生成API分離 | High | API/履歴 |
| deep二重消費・並列実行 | 仕様なし | 売上・権利不整合 | なし | 予約・確定・解放 | Critical | deep transaction |
| 生成失敗時に権利だけ減る | 仕様なし | 顧客損失 | なし | 期限付き予約と補償処理 | Critical | deep transaction |
| completedと消費の片側成功 | 仕様なし | 不整合 | なし | 同一トランザクション候補 | Critical | deep transaction |
| token/相談/本文をログ出力 | 一部コード次第 | 情報漏えい | 現ログは概ねイベントのみ | allow-list監査ログ | High | observability |
| DynamoDB内部情報を返す | detailはitem全体を返す | 内部属性露出 | 所有者確認 | DTO allow-list | High | history response |
| 認証APIのCORS `*` | 現在あり | 悪用面拡大 | token必要 | 許可Origin固定 | High | API共通基盤 |
| エラーに秘密情報 | 現在は概ね抑制 | 漏えい | 汎用文言 | 構造化安全エラー | Medium | API共通基盤 |
| 大量履歴生成 | 可能 | コスト・一覧劣化 | なし | user/IP rate limit＋上限 | High | rate limit |

## 6. 本番開放条件

1. 有料engineがブラウザから実行不能、または実行しても正式結果・履歴・権利として受理されない。
2. 会員属性はtoken由来user_idでDynamoDBから取得する。
3. modeをサーバーで解決する。
4. 本文・type・source・status・時刻をサーバーで確定する。
5. 冪等性、入力制限、レート制限、許可Origin、監査ログを実装する。
6. deepの消費仕様・キー構造・復旧手順を人間が承認する。
7. 失敗注入・並列・再試行・権限回帰テストを通す。
