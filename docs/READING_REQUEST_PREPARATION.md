# 鑑定リクエスト準備層

`prepareReadingRequest()` は、将来のHTTP handlerと鑑定エンジンの間に置く純粋な準備サービスです。

処理順序は次のとおりです。

1. 注入されたClockから `Asia/Tokyo` のサーバー暦日を確定
2. bodyを厳密検証し、whitelist済みrequestへ変換
3. Idempotency-Keyを小文字canonical UUID v4として検証
4. 認証済み会員contextの既存entitlementsから標準modeを取得
5. 既存 `resolveReadingMode()` で希望modeを判定
6. 利用不可ならengine実行前に `READING_MODE_NOT_AVAILABLE` で停止
7. token由来userIdと検証済み値だけで `PreparedReadingCommand` を構築
8. PIIを含まないallow-list監査イベントを1行JSONで記録

`PreparedReadingCommand.engineInput.plan` は会員planではなく解決済み鑑定modeです。premiumをengineへ渡しません。premium activeの標準modeはlight、deepは有効な権利と明示指定の両方が必要です。

この層はDynamoDB、AWS、HTTP、DOM、Storage、Astro client runtime、環境変数へ依存しません。会員context、Clock、監査sinkを呼び出し側から受け取ります。現段階ではengine、history、idempotency store、権利消費を実行しません。
