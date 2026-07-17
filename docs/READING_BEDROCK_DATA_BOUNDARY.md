# Bedrock送信データ境界

送信するのは、解決済みmode、表示用の名前、検証済み相談文、canonical title、`todayMessage`、`marginMessage`、`oneStep`、`avoidHint`、セクションのID・見出し・要約・本文だけです。

Authorization、session token、user_id、メール、パスワード、AWS資格情報、DynamoDB item、会員テーブルの生属性、決済属性、request header、内部エラー、stack、idempotency recordは送りません。生年月日はcanonical本文に必要な計算結果があるため、文章整形用データへ重ねて送りません。

相談文は命令ではなくデータとして区切ります。prompt全文、モデル本文、名前、生年月日、相談文は監査ログへ保存しません。監査ログはprovider、prompt version、mode、所要時間、結果、安全なerror code、文字数、token数だけをallow-listで記録します。
