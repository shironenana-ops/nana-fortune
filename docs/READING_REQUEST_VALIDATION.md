# 鑑定リクエスト入力検証

`validateReadingRequest()` は `unknown` を受け取り、許可フィールドだけで新しい値を構築します。受信objectをspreadせず、カスタムprototype、配列、null、プリミティブ、未知フィールドをfail closedで拒否します。

正式な入力は `name`、`birth_date`、任意の `question`、任意の `requested_mode` だけです。`gender` は現在の `ShironeEngineInput` に存在せず計算にも使われないため受け付けません。`today` はサーバー管理値です。

文字数はUTF-16 code unitsではなくUnicode code pointsで数えます。氏名のNFKC変換や内部空白の再構成は行いません。生年月日は正規表現とUTC上の年月日往復で実在性を確認し、`Date.parse()` の緩い解釈には依存しません。

エラーには入力値を含めません。監査ログにも氏名、生年月日、質問、raw bodyを記録しません。
