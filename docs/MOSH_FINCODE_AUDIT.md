# MOSH＋fincode 課金基盤監査

## 既存構成

- 会員ランク：`free` / `light` / `premium`
- 鑑定権限：freeはfree、lightはfree＋light、premiumはfree＋light＋deep
- 音声：premium会員、または対象履歴の単体購入権で利用可能
- users系フィールド：`plan`、`subscription_status`、`monthly_voice_limit`、`monthly_voice_used`、`extra_voice_remaining`
- 音声消費順：月次残数を先に消費し、不足時に `extra_voice_remaining` を1減らす

旧 `public/js/billing.js` にはStripe Checkout用API URLとfetchが残っていましたが、`BILLING_DISABLED = true` で停止されていました。`/join`、`/premium`、`/members`、`/history`に参照がありました。今回、互換シムから通信処理を除去し、旧ボタンは準備中案内だけを表示します。Lambda、usersスキーマ、会員権限、音声処理は削除・変更していません。

PR #41、#52、#57の個別本文はローカル履歴から特定できませんでした。課金停止の現行根拠として `docs/release/2026-07-07-billing-off-release-checklist.md` と旧スクリプトを確認しました。

## 公式公開情報で確認した事項（2026-07-17確認）

- 外部サイトから公開サービスURLへリンク可能（確定URLを使用）
- 月額サブスクは申込時に初回決済、解約しない限り毎月自動更新
- 利用者はMOSHのサブスク一覧から解約。解約時点でMOSH上の提供は終了
- 更新失敗時は数日おきに再決済し、複数回失敗で強制解約の可能性
- 販売者は顧客詳細で決済履歴・契約状態を確認可能
- 支払い履歴にはサービス名、金額、申込日時、支払方法が表示
- 1決済ごとのPDF領収書発行機能がある
- 購入後の自動送信メッセージを設定可能
- fincodeクレジットカード決済の販売手数料は1決済7％
- fincode返金には条件があり、記録が残る方法で購入者と合意する必要がある

公式資料：

- https://help.mosh.jp/c4f6a9a344a044c7b16bbf0f623a2964/%E6%9C%88%E9%A1%8D%E3%82%B5%E3%83%96%E3%82%B9%E3%82%AF%E3%81%AE%E8%A7%A3%E7%B4%84
- https://help.mosh.jp/615539e435a54bfc8e943fdab601ea4e/%E3%82%B5%E3%83%96%E3%82%B9%E3%82%AF%E3%83%AA%E3%83%97%E3%82%B7%E3%83%A7%E3%83%B3%E6%B1%BA%E6%B8%88%E8%A7%A3%E7%B4%84%E6%96%B9%E6%B3%95
- https://help.mosh.jp/33222b9b87e449ddb40a756320656c79/fincode%E6%B1%BA%E6%B8%88%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6
- https://help.mosh.jp/%E6%96%B0%E8%A6%8F%E7%94%B3%E8%BE%BC%E8%80%85%E3%81%B8%E3%81%AE%E8%87%AA%E5%8B%95%E9%80%81%E4%BF%A1%E3%83%A1%E3%83%83%E3%82%BB%E3%83%BC%E3%82%B8

## 公式公開情報では確認できない事項

- 白音七が利用可能なAPIの申請・認証・エンドポイント
- 購入、解約、支払い失敗Webhookの具体仕様
- 契約者一覧のCSVエクスポート可否（CSVインポート情報とは区別）
- 外部サイトで安定して使える申込みID／契約ID
- サブスク状態の外部取得方法
- 安全なテスト決済・サンドボックス
- 300円決済の精算額における端数処理

これらはMOSHサポートへの問い合わせが必要です。確認できるまで自動連携を実装しません。
