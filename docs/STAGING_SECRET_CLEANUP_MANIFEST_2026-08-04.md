# Staging Secret Cleanup Manifest — 2026-08-04

## 別アカウント誤配置候補

- staging Webhook署名専用Secretの誤配置候補が、`READING_STAGING_ACCOUNT`とは異なるAWSアカウントに存在すると人間から報告された。
- 今回、その別アカウントには接続していない。
- 対象Secretの変更、version追加、削除は行っていない。
- account識別子、Secret名、ARN、値はこのmanifestへ記録しない。
- cleanupは別途、明示承認と対象アカウント境界確認を行った工程で判断する。
