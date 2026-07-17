# Node.js鑑定基盤のセッション認証

## 既存形式

白音七のtokenはJWTではありません。`lambda/login.py`の`create_session_token()`が発行する独自2セグメント形式です。

```text
Base64URL(UTF-8 JSON payload).Base64URL(HMAC-SHA256 signature)
```

署名対象はBase64URL化したpayload文字列そのものです。paddingは除去され、secretと署名対象はいずれもUTF-8です。payloadは`user_id`、整数`iat`、整数`exp`を持ち、loginでは24時間後をexpに設定します。時刻はUnix秒でtimezone非依存です。

既存検証は`history_save.py`、history list/detail/delete、`voice_upload.py`等で同じ方式です。`Authorization`は大文字小文字を無視してheader名を探しますが、値は厳密な`Bearer `で始まる必要があります。token本体の前後空白は除去されます。

Node実装は`src/server/auth/sessionToken.ts`です。標準cryptoのHMAC-SHA256と`timingSafeEqual()`を使い、Python形式以外を追加受理しません。secret未設定は500相当の設定エラーとしてfail closedします。

既存Pythonは`exp < now`を拒否しますが、未来の`iat`やclock skewを検査しません。完全互換性のためNodeも同じです。未来iat拒否を追加する場合はPython・Node・既存tokenへの影響を揃える別PRが必要です。

## 拒否条件

- headerなし、Bearer以外、空・4096文字超・改行・複数値
- 2セグメント以外、非canonical Base64URL、不正JSON
- HMAC不一致、user_id欠損・空・型不正
- iat／expが整数以外、期限切れ

token、Authorization、user_id、secret、内部例外をログ・レスポンスへ出しません。fixtureは実行時に架空secretと架空userを使ってPython／Node相互生成・検証を行います。

将来handlerはheader解析、token検証、token由来user_idでRepository照会、の順に使用します。body/queryのuser_idは受け取りません。
