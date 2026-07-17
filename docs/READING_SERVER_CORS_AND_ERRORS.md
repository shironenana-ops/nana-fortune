# Node.js鑑定基盤のCORS・エラー・監査ログ

## CORS

許可Originは`READING_ALLOWED_ORIGINS`のカンマ区切り完全originです。scheme・host・portを含む文字列全体で完全一致し、未設定、空、不正URL、`*`、`null`、改行、username、trailing slashをfail closedにします。本番・preview・localhostはいずれも環境変数へ明示された場合だけ許可します。

Originなしはサーバー間リクエスト候補として処理を許可しますがCORS許可originを返しません。認証は別途必須です。credentials cookieは使用せず、`Access-Control-Allow-Credentials`を付けません。

- method：POST、OPTIONS
- headers：Content-Type、Authorization、Idempotency-Key
- preflight cache：600秒
- `Vary: Origin`：常に付与

既存Python APIのwildcard CORSは今回変更しません。新しいNode handlerだけがこの基盤を使います。

## 安全なエラー

`ServerFoundationError`を固定codeへ分類し、`toSafeErrorResponse()`が固定status・固定message・request_idだけを返します。401は認証情報、403はOrigin、404はuser不存在、500は設定・内部、503はuser store一時障害です。

stack、token、Authorization、user_id、メール、password、DynamoDB本文、AWS request ID、secret名・値、内部例外messageを返しません。不明例外は`INTERNAL_ERROR`です。

request_idはNode標準`randomUUID()`で生成します。クライアント候補は8～128文字の限定文字だけ採用し、不正・長大・改行入りは再生成します。PIIやtokenを埋めません。

## 監査ログ

監査ログは1イベント1行JSONです。許可された固定項目だけを組み立て、制御文字を置換し、任意objectをspreadしません。sinkはテスト・将来CloudWatch向けに差し替え可能です。

生user_idは`READING_AUDIT_HASH_SECRET`でHMAC-SHA256化し24hexへ短縮します。session secretとは分離します。監査secret未設定時はuser_refだけを省略し、認証処理は継続します。可用性を保ちながらPII漏えいを避ける方針です。

token、secret、生user_id、メール、password、生年月日、氏名、相談、本文、DynamoDB item、AWS・MOSH・fincode情報、未加工stack/messageは禁止です。

## 環境変数

- `SESSION_TOKEN_SECRET`：既存token検証。必須
- `USERS_TABLE_NAME`：usersテーブル。必須
- `READING_ALLOWED_ORIGINS`：完全origin一覧。必須
- `READING_AUDIT_HASH_SECRET`：user_ref生成。未設定時はuser_ref省略
- `DEPLOY_VERSION`／`ENGINE_VERSION`：将来の監査任意項目

将来handlerはrequest_id生成、CORS検査、認証、会員context取得、安全ログ、固定エラー変換の順に組み込みます。このPRではHTTP/Lambda handlerを作りません。
