# Node.js鑑定基盤の会員コンテキスト

## 正本と環境変数

usersテーブルのパーティションキーは既存PythonのGetItemから`user_id`（文字列）と確認しました。新しいNode基盤は専用名`USERS_TABLE_NAME`を使い、未設定時はfail closedします。

既存コードには`login.py`の汎用`TABLE_NAME`と、`voice_upload.py`／`lambda_function.py`の`USERS_TABLE_NAME`が混在します。新しい鑑定基盤では後者を採用します。既存Pythonは変更しません。

## Repository境界

`UserRepository.findMembershipByUserId()`だけを上位層へ公開します。Dynamo adapterはAWS SDK v3のGetItemとProjectionExpressionを使い、次だけを取得・変換します。

- plan
- subscription_status
- deep_enabled
- monthly_voice_limit／monthly_voice_used
- extra_voice_remaining
- cancel_at_period_end
- current_period_end

password、メール、旧Stripe属性、未知属性、DynamoDB item全体、AWS request IDは返しません。不存在はnull、一時障害は安全な`USER_STORE_UNAVAILABLE`へ変換します。ConsistentReadはfalseです。

`loadAuthenticatedMembershipContext()`はtoken由来user_idだけでRepositoryを呼び、既存`membershipEntitlements.ts`へwhitelist済み会員値を渡します。不明plan、負数、不正数、inactive等は既存共通ルールで安全に処理されます。判定を複製しません。

内部コンテキストはuserIdを持ちますが、`toPublicMembershipSummary()`はuserIdや生itemを含みません。テストはfake Repository／fake Dynamo senderを注入し、実AWSへ接続しません。

## AWS SDK

`@aws-sdk/client-dynamodb`を固定バージョンで直接依存へ追加します。SDKはESM bundleからexternalizeし、将来のLambda artifactへproduction `node_modules`として同梱します。SDK内部のCommonJS動的requireを壊さず、Lambda runtime付属SDKへも暗黙依存しないためです。サイズはbundle本体と依存一式を分けて管理します。
