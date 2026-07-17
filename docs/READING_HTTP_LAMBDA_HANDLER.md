# 統合鑑定 HTTP／Lambda handler基盤

## 採用event

API Gateway HTTP API payload format version `2.0`だけを受理します。`rawPath`は`/reading/generate`、methodは`requestContext.http.method`から取得します。REST API v1の`httpMethod`、曖昧な混在event、Lambda Function URL固有形式は受理対象にしません。

Node.js 22のESM artifactを`npm run build:reading-api-handler`で生成します。AWS SDKパッケージはbundleからexternal化しますが、固定versionのproduction dependencyとしてpackageに保持し、runtime付属SDKへ暗黙依存しません。module import時にAWS通信は行いません。

## 処理順序

1. payload v2.0、request context、path、method、header型を検証
2. API Gateway request ID候補を安全に確定
3. Originをexact allow-listで評価
4. OPTIONSはCORS応答だけを返す
5. kill switchを確認
6. Content-Typeを完全一致で確認
7. encoded／decoded byte上限を確認しJSONをunknownとしてparse
8. Bearer tokenをPython互換validatorで検証
9. token由来user IDだけでmembership projectionを照会
10. UUID v4 Idempotency-Keyと鑑定入力を検証
11. Asia/Tokyoの日付と既存resolverでmodeを確定
12. request_ref／fingerprintを生成しconditional予約またはcompleted replay
13. 予約勝者だけ自前エンジンを1回実行
14. lightだけ既存Bedrock rendererを試行（deepは追加kill switchで既定拒否）
15. 公開DTOをallow-listで新規構築
16. history Putとidempotency completedを同一transactionで確定
17. transaction成功後だけCORS／request ID付き200を返す

不許可Originではtoken検証、Repository、engine、Bedrockを開始しません。OriginなしPOSTはCORS headerを返しませんが、認証は省略しません。

## CORSとエラー

許可Originには成功・失敗とも`Access-Control-Allow-Origin`と`Vary: Origin`を返します。不許可OriginにはCORS許可headerを返しません。OPTIONSは認証、会員照会、engine、Bedrockを呼びません。POST／OPTIONS以外は405と`Allow: POST, OPTIONS`です。

公開エラーは固定code、固定message、request IDだけです。stack、内部例外message、token、user ID、名前、生年月日、相談、Idempotency-Key、会員item、AWS request ID、生モデル出力は返しません。

## 安全スイッチと入力上限

- `READING_GENERATE_API_ENABLED`: 厳密に`true`だけ有効
- decoded JSON body: 16KiB以下
- base64 encoded body: 24KiB以下
- JSON top-level: plain objectのみ
- Content-Type: `application/json`、任意で`charset=utf-8`

実環境の環境変数値はこの実装では追加していません。

## Bedrockと公開DTO

canonical engine結果を必ず先に確定します。freeはBedrockを呼びません。light／deepはforced tool-use、Node側validator、canonical順再構築を行う既存rendererだけを利用します。fallback可能なBedrock障害はHTTP 5xxへ昇格せず、安全なcanonical鑑定を200で返します。

公開DTOへ含めるのはrequest ID、resolved mode、完了状態、rendering状態、title、sectionのid／heading／body、one step、avoid hintだけです。knowledge payload、history payload、context、audio script、icon hints、会員属性、model ID、provider内部値は除外します。

## 未完成の境界

- deep権利と履歴確定の原子性なし
- deep権利の予約、消費、失敗時解放なし
- 会員別rate limitなし
- API Gateway／Lambda／IAM／deploy／UI接続なし

次PRではDynamoDBによる冪等性予約・確定と、履歴保存・deep権利確定を片側成功させない永続化境界を実装します。それまでは一般利用者へlight／deepを開放しません。
