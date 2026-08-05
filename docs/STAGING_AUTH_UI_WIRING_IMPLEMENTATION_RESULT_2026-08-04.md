# Staging Auth / Local UI Wiring Implementation Result — 2026-08-04

## 結論

staging専用の既存認証実装を再利用し、Login、Signup、Membership Statusのruntimeとrouteを、全機能flagがfalseの状態で配備した。

## Retained Log Groupの復旧

前回rollbackで保持された認証Lambda用Log Group 3件について、次を確認した。

- 名前、保持期間30日、KMS未設定、STANDARD classがIaCと一致
- Log Stream 0件、stored bytes 0
- 同一staging stackのCloudFormation所有タグだけが存在
- `DeletionPolicy: Retain`と`UpdateReplacePolicy: Retain`が定義済み
- IMPORT Change Setは3件のImportだけ
- Create、Modify、Delete、Replacementは0件
- import後、3件ともstack管理対象
- 個別driftは3件とも`IN_SYNC`

Log Groupの削除、別名化、ログ本文取得は行っていない。

## 認証配備Change Set

- Add: 16件
- Modify: 8件
- Remove: 0件
- Replacement: 0件
- production参照: 0件
- 既存workerの実効設定変更: 0件
- 既存request/status/Webhook Integrationの実効設定変更: 0件
- IAM wildcard write追加: 0件

## 配備後確認

- stack: `UPDATE_COMPLETE`
- CloudFormationの関連flag 13件: すべてfalse
- Lambda実環境の関連flag: すべてfalse
- Light/Deep EventSourceMapping: 2件とも`Disabled`
- Bedrock: false
- Login、Signup、Membership Status route: 存在
- disabled route: 固定された安全な4xx/503契約で拒否
- Users mutation: 0件
- account作成: 0件
- session発行: 0件
- fincode TEST決済: 0件
- production access / mutation: 0件

## 判定

`STAGING_AUTH_UI_WIRING_READY`
