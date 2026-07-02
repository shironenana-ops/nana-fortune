# 2026-07-07 課金OFF公開 最終チェックリスト

7/7 は課金OFFで公開する。`BILLING_DISABLED = true` を維持し、Stripe 本番課金、Webhook、Customer Portal は公開時点で ON にしない。

## 1. Git / ブランチ確認

- [ ] `main` ブランチにいる
- [ ] `main` が `origin/main` と同期している
- [ ] 作業ブランチに未反映の必要差分が残っていない
- [ ] `git status --short` が想定どおり
- [ ] 未追跡ファイルが残っていない、または公開作業に含めない判断ができている
- [ ] `zip` / `snapshot` / `backup` ファイルが Git に混入していない
- [ ] `git add .` を使わず、必要な場合は対象ファイルを明示指定している

確認コマンド:

```powershell
git branch --show-current
git pull origin main
git status --short
git ls-files | Select-String -Pattern "\.zip$|snapshot|backup|bk"
```

## 2. build / 型チェック

- [ ] TypeScript の型チェックが成功する
- [ ] Astro build が成功する
- [ ] `git diff --check` が成功する
- [ ] build 警告が既存警告か新規警告か切り分けられている
- [ ] 新規警告がある場合、公開判断に影響するか確認済み

確認コマンド:

```powershell
npm.cmd exec tsc -- --noEmit
npm.cmd run build
git diff --check
```

既存警告として扱うもの:

- [ ] `blog/[...slug].astro` の `getStaticPaths()` 警告
- [ ] ローカル Node 24 / Vercel Node 22 警告
- [ ] `@astrojs/vercel/serverless` deprecated 警告

## 3. 文字化けチェック

- [ ] 主要ソースに文字化け候補がない
- [ ] 日本語の alert / ボタン / 法務文言が読める
- [ ] PR タイトルや本文に文字化けがない

確認コマンド:

```powershell
Get-ChildItem -Path src,public\js -Include *.astro,*.ts,*.json,*.js -Recurse |
  Select-String -Pattern "繝|縺|譛|螟|逋ｽ|荳|蛻|蜿|�"
```

## 4. 課金OFF確認

- [ ] `public/js/billing.js` の `BILLING_DISABLED = true` を維持している
- [ ] 課金ボタン押下時に checkout API が呼ばれない
- [ ] `/members` の `subscription/change-plan` が呼ばれない
- [ ] Customer Portal 導線がユーザー画面に出ていない
- [ ] 価格表示が販売中の確定価格に見えない
- [ ] ボタンが JS 実行前から準備中表示になっている
- [ ] ボタンを押しても料金が発生しない案内で止まる
- [ ] 「今すぐ買える」「今すぐ申し込める」に見える文言がない

確認ページ:

- [ ] `/join`
- [ ] `/premium`
- [ ] `/members`
- [ ] `/history`

確認コマンド:

```powershell
Select-String -Path public/js/billing.js -Pattern "BILLING_DISABLED|checkout|fetch"

Get-ChildItem -Path src,public\js -Include *.astro,*.ts,*.json,*.js -Recurse |
  Select-String -Pattern "¥980|980円|¥2,980|2,980円|2980円|月額980|月額2980|単発300円|¥300|300円|買い切り|Customer Portal|カスタマーポータル|今すぐ申し込む|購入する|申し込む|解約できます|正式公開前"
```

## 5. 準備中ページ確認

対象ページ:

- [ ] `/premium/light`
- [ ] `/premium/deep`
- [ ] `/premium/voice`
- [ ] `/premium/voice-processing`

確認観点:

- [ ] 準備中ページとして自然に見える
- [ ] 入力フォームが出ていない
- [ ] 送信ボタンがない
- [ ] アップロードや録音ができない
- [ ] 処理中・生成中・解析中に見えない
- [ ] 料金が発生しないことが分かる
- [ ] TOP / 会員ページ / 履歴などへの戻り導線がある
- [ ] スマホ表示で崩れていない

## 6. 無料ユーザー導線確認

対象ページ:

- [ ] `/`
- [ ] `/diagnosis`
- [ ] `/result`
- [ ] `/history`
- [ ] `/history/[id]`
- [ ] `/login`
- [ ] `/signup`
- [ ] `/members`
- [ ] `/compat`
- [ ] `/about`
- [ ] `/blog`
- [ ] `/contact`

確認観点:

- [ ] スマホで崩れない
- [ ] ログイン前後の表示が破綻しない
- [ ] 無料鑑定が分かりやすい
- [ ] 履歴保存ができる
- [ ] 履歴一覧が見える
- [ ] 履歴詳細が見える
- [ ] 削除が必要な場合、削除導線が安全に動く
- [ ] 旧履歴があっても画面が落ちない
- [ ] エラー表示が怖すぎない
- [ ] 内部用語がユーザー画面に出ていない

## 7. 法務ページ確認

対象ページ:

- [ ] `/terms`
- [ ] `/privacy`
- [ ] `/commercial-transactions`
- [ ] `/disclaimer`
- [ ] `/contact`

確認観点:

- [ ] 課金OFF公開と矛盾していない
- [ ] 「有料提供開始前」など、課金OFF公開後も矛盾しにくい表現になっている
- [ ] 料金が発生するように見えない
- [ ] Customer Portal が今使えるように見えない
- [ ] 解約方法は有料提供開始時に案内する表現になっている
- [ ] 問い合わせ先が現状に合っている
- [ ] 医療・法律・投資の免責がある
- [ ] 「占いは個人の資産」という履歴思想と矛盾していない

## 8. スマホ確認

最低確認ページ:

- [ ] `/`
- [ ] `/diagnosis`
- [ ] `/result`
- [ ] `/join`
- [ ] `/premium`
- [ ] `/members`
- [ ] `/history`
- [ ] `/terms`
- [ ] `/commercial-transactions`
- [ ] `/contact`

確認観点:

- [ ] 横スクロールがない
- [ ] ボタンが押せる
- [ ] 文字が読める
- [ ] 背景と文字のコントラストが悪くない
- [ ] ヘッダー / メニューが使える
- [ ] 準備中ボタンが灰色の素ボタンに見えない
- [ ] 法務ページの表が読みづらくない

## 9. Network確認

DevTools Network で以下が出ないことを確認する。通常のページ読み込み、画像読み込み、CSS、JS は対象外。

- [ ] `checkout`
- [ ] `subscription`
- [ ] `voice`
- [ ] `create`
- [ ] `upload`
- [ ] `portal`

確認ページ:

- [ ] `/join`
- [ ] `/premium`
- [ ] `/members`
- [ ] `/history`
- [ ] `/premium/light`
- [ ] `/premium/deep`
- [ ] `/premium/voice`
- [ ] `/premium/voice-processing`

## 10. 公開前の人間確認

- [ ] TOP の第一印象が白音七らしい
- [ ] 無料鑑定の流れが分かりやすい
- [ ] 会員登録に不安感がない
- [ ] 課金OFFなのに販売中に見えない
- [ ] 白音七らしい静かな雰囲気が保たれている
- [ ] 変な内部用語が出ていない
- [ ] 「準備中」が多すぎて不安にならない
- [ ] 戻る導線が自然にある
- [ ] 問い合わせ先が分かる
- [ ] 法務リンクが主要ページから辿れる

## 11. 公開判断

### 公開OK

- [ ] build / 型チェックが成功している
- [ ] 文字化けがない
- [ ] 課金が発生する導線が開いていない
- [ ] 無料鑑定、ログイン、履歴、主要ページが確認済み
- [ ] 法務ページが課金OFF公開と矛盾していない
- [ ] 人間確認で大きな違和感がない

### 修正してから公開

- [ ] 軽微な文言違和感がある
- [ ] 一部ページでスマホ表示の崩れがある
- [ ] 課金OFFとは分かるが、表現が少し強い / 硬い
- [ ] 法務ページに補足したい項目がある

### 公開延期

- [ ] 課金API、subscription、upload などが意図せず呼ばれる
- [ ] `BILLING_DISABLED = true` が維持されていない
- [ ] build または型チェックが失敗する
- [ ] 主要導線がスマホで使えない
- [ ] 法務ページが課金OFF公開と明確に矛盾している
- [ ] ユーザーが料金発生や購入可能状態を誤解しやすい
