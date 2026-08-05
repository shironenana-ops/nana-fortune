# fincode全商品再申請向け 最終ローカルレビュー

- レビュー日: 2026-08-05（JST）
- 実装開始commit: `8067b0ebaeb6aee598bfcf1b7f829f2a67a6d94f`
- 対象: 白音七の公開サイトとfincode再申請回答
- 申請商品: ライト会員、プレミアム会員、音声鑑定1回分
- 最終判定: `FINCODE_FULL_CATALOG_REAPPLICATION_READY = YES`

## 1. 申請契約

| 商品 | 公開・申請する内容 |
|---|---|
| ライト会員 | 月額980円（税込）・自動更新。ライト鑑定月5回、音声鑑定月3回 |
| プレミアム会員 | 月額2,980円（税込）・自動更新。ライト鑑定月20回、深掘り鑑定月3回、音声鑑定月10回 |
| 音声鑑定1回分 | 300円（税込）・買い切り・自動更新なし。音声鑑定1回分 |

月額商品の支払時期は初回申込時と以後の契約周期ごと、買い切り商品は申込時です。決済確認後に原則直ちに反映し、処理遅延時は24時間以内を目安とします。

月額商品は問い合わせ先への連絡で解約でき、契約期間末まで利用できます。次回以降の更新を停止し、残期間の日割り返金は行いません。買い切り商品に自動更新と解約手続きはありません。お客様都合の返金・キャンセルは原則不可とし、重複請求、未提供、白音七側不具合は個別対応します。

## 2. P0解消確認

- 公開販売allow-listを3商品へ統一しました。
- 3商品の価格、契約種別、利用枠、支払・提供・解約・返金条件を公開ページ間で統一しました。
- 全商品に未ログインで確認できる申込内容確認ページを設けました。
- 「今後提供予定」「機能準備中」「現在申込不可」を除去しました。
- サービス機能は準備済みで、カード決済受付だけがfincode本番審査待ちと表示します。
- productionカード決済のfail closed状態は変更していません。
- 課金ロジック、quota、AWS、fincode PRODには変更を加えていません。

## 3. 審査担当が辿るページ

1. `https://www.nana-fortune.com/`
2. `https://www.nana-fortune.com/join`
3. `https://www.nana-fortune.com/checkout?plan=light`
4. `https://www.nana-fortune.com/checkout?plan=premium`
5. `https://www.nana-fortune.com/checkout?plan=voice_single`
6. `https://www.nana-fortune.com/commercial-transactions`
7. `https://www.nana-fortune.com/terms`
8. `https://www.nana-fortune.com/privacy`
9. `https://www.nana-fortune.com/contact`
10. `https://www.nana-fortune.com/signup`
11. `https://www.nana-fortune.com/login`
12. `https://www.nana-fortune.com/members`
13. `https://www.nana-fortune.com/premium/light`
14. `https://www.nana-fortune.com/premium/deep`
15. `https://www.nana-fortune.com/premium/voice`

公開deploy前のため、今回の画面確認は同じrouteをlocalhostで行います。

## 4. 申請画面へ転記する最終回答

### 商品・価格

> ライト会員は月額980円（税込）の自動更新で、ライト鑑定月5回、音声鑑定月3回です。プレミアム会員は月額2,980円（税込）の自動更新で、ライト鑑定月20回、深掘り鑑定月3回、音声鑑定月10回です。音声鑑定1回分は300円（税込）の買い切りで、自動更新はありません。

### 支払・提供

> 月額商品は初回申込時と以後の契約周期ごと、買い切り商品は申込時に、fincode byGMOを利用してクレジットカード決済を行います。決済完了および白音七での確認後、原則として直ちに利用権へ反映します。処理に時間を要する場合は24時間以内を目安に反映します。

### 解約・返金

> 月額商品は登録メールアドレスから問い合わせ先へ、対象プランと解約希望をご連絡ください。現在の契約期間末まで利用でき、次回以降の自動更新を停止します。お客様都合のキャンセル・返金および残期間の日割り返金は原則として行いません。重複請求、サービス未提供、白音七側のシステム不具合は個別に対応します。買い切り商品に自動更新と解約手続きはありません。

### カード情報

> カード番号、有効期限、セキュリティコードはfincodeの仕組みで取り扱い、白音七のサーバーでは取得・保存しません。

### サイトが準備中である理由

> 3商品のサービス機能、料金、利用枠、申込条件、法定表示、規約、問い合わせ先、申込内容確認画面は準備済みです。fincode本番環境の審査完了前に実決済が発生しないよう、カード決済受付だけを安全側に停止しています。

## 5. ローカル検証

| 検証 | 結果 |
|---|---|
| targeted tests | 11/11 PASS |
| full regression | 340/340 PASS（最終状態で1回） |
| TypeScript noEmit | TypeScript 5.9.3でPASS（依存関係の変更なし） |
| Astro build | PASS |
| secret scan | 対象22ファイル、高確度検出0件 |
| `git diff --check` | PASS |
| localhost画面確認 | `/join` と3商品の申込確認をPC・390px相当で確認。禁止表現・横スクロールなし、production決済ボタンdisabled |

## 6. 未実施事項

- 公開サイトへのdeploy
- 公開URLでの再確認
- fincode PROD通信
- fincode管理画面への再申請送信
- production AWS変更
- merge

ローカル実装の完了は、公開反映やfincode再申請の完了を意味しません。
