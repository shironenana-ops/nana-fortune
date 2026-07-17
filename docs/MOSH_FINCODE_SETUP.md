# MOSH＋fincode 初期設定

## 役割

- 白音七：商品説明、会員アカウント、利用権、履歴、音声枠
- MOSH：申込み、決済、契約者管理、継続請求、解約
- fincode：MOSH内部の決済基盤

白音七はStripeを使用せず、fincode APIにも直接接続しません。カード番号を取得・保存・送信しません。

## 確定商品

| 商品 | 価格 | 種別 | MOSH URL |
|---|---:|---|---|
| ライト会員 | 月額980円 | サブスクリプション | https://mosh.jp/services/385958?openExternalBrowser=1 |
| プレミアム会員 | 月額2,980円 | サブスクリプション | https://mosh.jp/services/385965?openExternalBrowser=1 |
| 音声単体 | 300円 | 買い切り | https://mosh.jp/services/385969?openExternalBrowser=1 |

月額商品は解約しない限り自動更新です。fincodeのクレジットカード販売手数料は1決済7％です。

## 公開前のMOSH確認

各サービスの公開状態、価格、課金周期、解約説明、購入後メッセージ、申込者情報、返金条件を管理画面で確認します。購入後メッセージには「白音七と同じメールアドレスを使うこと」と白音七問い合わせ先を記載します。

## 白音七の課金フラグ

Vercelで `PUBLIC_MOSH_BILLING_ENABLED=true` を明示した場合だけMOSH CTAを表示します。未設定、空、false、その他の値はOFFです。`.env`はコミットしません。

1. Preview環境でOFF表示を確認
2. Preview環境でtrueを設定し、3 URLと価格を確認
3. MOSH商品設定と法務表示を人間が照合
4. 本番環境変数の変更は別途承認を得て実施

APIキー、fincode資格情報、カード情報は白音七へ設定しません。
