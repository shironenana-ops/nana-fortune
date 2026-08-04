# Staging Secret Contract Recovery Result — 2026-08-04

## 結論

`READING_STAGING_ACCOUNT` 内で、Runtime SecretとWebhook署名専用Secretを分離し、staging runtimeが必要とする正規4キーを復旧した。

Secret値、値の長さ、hash、ARN全文、環境変数mapは、この文書・ログ・repository・一時ファイルへ記録していない。

## 実施結果

- Webhook Lambdaのコード契約を先に確認した。
- Runtime Secretに既存していたWebhook署名値を、単一Python/boto3プロセスのメモリ内だけで専用Secretへコピーした。
- 専用Secretは、コードが受理する単一キーJSON形式で作成した。
- Runtime SecretとWebhook署名専用Secretが別resourceであることをmetadataで確認した。
- 配備済みconsumer間で正規4値が欠落・空・不一致でないことを確認した。
- Runtime Secretの既存JSONを維持し、正規4キーをmerge-onlyで復旧した。
- merge後、正規4キーの存在とconsumer実効値との一致だけを再確認した。
- 既存キーの削除・変更は行っていない。
- 再実行では追加versionを作らず、`NOT_NEEDED`として冪等に完了した。

## 安全境界

- staging account・東京region・staging stackへ固定した。
- production Secretへのアクセスは0件。
- fincode PROD通信は0件。
- account作成、session発行、決済実行は0件。
- commit、push、PRは0件。

## 判定

`STAGING_SECRET_CONTRACT_RECOVERED`
