# 白音七 音声枠・利用回数管理 仕様設計

## 1. 目的

白音七のライトプラン、プレミアムプラン、音声買い切りで利用する「音声枠」と「鑑定回数」を、安全に管理するための仕様を定義する。

この仕様は、課金事故、二重消費、原価爆発、返金トラブル、ユーザー誤解、問い合わせ対応不能を防ぐことを目的とする。

PR #67 では仕様ドキュメントのみを追加する。コード修正、DB変更、API追加、既存Lambda変更、音声生成処理への接続は行わない。

## 2. 確定仕様

### 音声枠

ユーザー向けには「約2分までの音声生成」と表現する。

内部計算では、1枠 = 120秒 とする。

必要枠は以下で算出する。

```text
required_slots = ceil(estimated_duration_sec / 120)
```

| 見積もり時間 | 必要枠 |
|---:|---:|
| 0:01〜2:00 | 1枠 |
| 2:01〜4:00 | 2枠 |
| 4:01〜6:00 | 3枠 |
| 6:01〜8:00 | 4枠 |
| 8:01〜10:00 | 5枠 |
| 10分超 | 自動音声生成対象外 |

### 10分上限

AI自動音声生成は最大10分までとする。最大消費枠は5枠まで。

10分を超える鑑定は自動生成せず、白音七先生による予約制の個別鑑定へ案内する。個別鑑定は別料金とする。

10分上限を設ける理由:

- 音声品質を安定させるため
- ユーザーの待ち時間を抑制するため
- 原価を防衛するため
- 長尺鑑定は予約制個別鑑定へ案内するため

### プラン別の枠案

ライトプラン:

- ライト鑑定: 月5回
- 音声枠: 月3枠

プレミアムプラン:

- ライト鑑定: 月20回
- 深読み鑑定: 月3回
- 音声枠: 月10枠

音声買い切り:

- 音声枠: 1枠
- 約2分まで
- 300円想定

### 聞き直しと作り直し

生成済み音声の再生・聞き直しは無制限とする。

再生では音声生成コストを再発生させない。

以下は作り直し扱いとして音声枠を消費する。

- 声を変える
- 速度を変える
- 読み上げ文を変える
- 鑑定内容を変える
- 同じ鑑定をもう一度生成する
- ユーザー都合の再生成

以下は未決事項として残す。

- 誤字修正時の再生成扱い
- 軽微な句読点修正時の再生成扱い
- システム側の本文欠損時の再生成扱い

### 月額枠の繰り越し

月額特典の未使用音声枠は、period終了時に失効する。

次回periodへ繰り越さない。

買い切り枠は失効なし、または別途明示した有効期限に従う。

### キャンセル・返金

- 音声生成開始後のユーザー都合キャンセルは原則不可
- 生成完了後の自己都合による返金は不可
- システム不具合時のみ、枠を消費しない再生成または個別対応とする
- 返金ポリシーの詳細は、利用規約・特定商取引法ページ側でも整備する

## 3. DB設計

既存の `users.monthly_voice_used` の直更新を正式版の主役にはしない。

正式版では以下の3層に分ける。

1. `usage_quota`
2. `usage_logs`
3. `voice_requests`

### usage_quota

現在の残枠・使用済み数・予約中枠を管理する集計テーブル。

想定項目:

- `user_id`
- `period_key`
- `usage_type`
- `plan`
- `subscription_status`
- `limit`
- `used`
- `reserved`
- `subscription_remaining`
- `extra_remaining`
- `period_start`
- `period_end`
- `version`
- `updated_at`

### usage_logs

なぜ枠が増減したかを追う不変ログ。

想定項目:

- `usage_log_id`
- `user_id`
- `usage_type`
- `action`
  - `reserve`
  - `commit`
  - `release`
  - `grant`
  - `adjust`
  - `expire`
- `credit_cost`
- `credit_source`
  - `subscription`
  - `extra_purchase`
  - `free_retry`
  - `admin_adjust`
- `source_history_id`
- `source_voice_id`
- `voice_request_id`
- `idempotency_key`
- `status`
- `failure_category`
- `failure_reason`
- `retry_charge_policy`
- `created_at`

### voice_requests

音声生成1件ごとの状態を管理する。

想定項目:

- `voice_request_id`
- `user_id`
- `history_id`
- `request_type`
- `settings_hash`
- `text_hash`
- `estimated_duration_sec`
- `estimated_slots`
- `final_duration_sec`
- `final_slots`
- `status`
  - `requested`
  - `reserved`
  - `generating`
  - `completed`
  - `failed`
  - `released`
  - `expired`
  - `manual_review`
- `audio_s3_key`
- `error_code`
- `is_free_retry`
- `reserved_expires_at`
- `created_at`
- `updated_at`

`reserved_expires_at` は必須とする。Lambda停止や外部API障害により予約枠が戻らない事故を防ぐため、期限切れ予約を後続処理で release できるようにする。

## 4. 枠消費フロー

単純な `used += 1` ではなく reserve 方式にする。

1. 見積もり
2. `voice_requests` を `requested` で作成
3. `usage_quota` の枠を `reserved` に移す
4. `usage_logs` に `reserve` を記録
5. 音声生成
6. 成功したら `completed`
7. `reserved` から `used` へ `commit`
8. `usage_logs` に `commit` を記録
9. 失敗したら `reserved` を戻す
10. `usage_logs` に `release` または `failed` を記録

### DynamoDB TransactWriteItems が必要な箇所

- `voice_requests` 作成
- `usage_quota` の `reserved` 加算
- `usage_logs` の `reserve` 作成
- `idempotency_key` の重複防止レコード作成

### idempotency key

二重クリック、再送信、Lambdaリトライ対策として idempotency key は必須とする。

候補:

```text
sha256(user_id + history_id + request_type + settings_hash + text_hash)
```

`request_created_at` はキー本体に入れない。

同じ鑑定・同じ本文・同じ声・同じ速度なら同一扱いにする。

声、速度、本文、鑑定内容が変わる場合は別リクエストとして扱う。

すでに `completed` の同一音声がある場合は、再生成せず既存の `audio_s3_key` を返す。

## 5. 失敗時・無料再生成

以下は白音七側の不具合として扱い、枠を消費しない再生成または個別対応の対象とする。

- TTS API失敗
- S3保存失敗
- 音声ファイル参照不能
- 明らかな途中切れ
- システム側タイムアウト
- その他、白音七側の不具合

途中切れなど自動判定が難しいものは、`manual_review` を挟める設計にする。

ユーザー都合の作り直しと、白音七側の不具合による無料再生成を `usage_logs` と `voice_requests` で後から区別できるようにする。

## 6. 原価防衛

白音七では、AI生成・音声生成・決済手数料・振込手数料を含む変動費を、原則として売上の30％以内に抑えることを目標にする。

追加で以下も原価・運用負荷として考慮する。

- S3保存費用
- S3 GET回数
- CloudFront転送量
- Lambda実行回数
- API Gatewayリクエスト数
- 無料再生成分の原価
- サポート対応コスト

防衛ルール:

- ライト鑑定は原則ローカル生成
- deep鑑定は月3回まで
- 音声枠はライト月3枠、プレミアム月10枠
- 音声1枠は約2分まで
- AI自動音声生成は最大10分 / 最大5枠まで
- 月額特典の音声に Long-Form は使わない
- ユーザー都合の作り直しは必ず音声枠を消費
- 生成済み音声の聞き直しは無制限
- システム不具合時のみ無料再生成

将来的に記録したい項目:

- `tts_model`
- `bedrock_model`
- `estimated_chars`
- `estimated_tokens`
- `estimated_duration_sec`
- `estimated_cost_jpy`
- `used_slots`
- `success`
- `failed`
- `free_retry`

障害や原価急増に備えて、以下のような feature flag を用意する。

- `VOICE_GENERATION_ENABLED`
- `VOICE_FREE_RETRY_ENABLED`
- `VOICE_MAX_AUTO_SECONDS`
- `VOICE_MAX_RETRY_COUNT`

## 7. 外部価格変動

AWS Bedrock、Amazon Polly、S3、CloudFront、決済サービス等の料金体系は将来的に変わる可能性がある。

外部サービスの価格改定や提供条件変更により原価率30％以内の維持が難しくなった場合は、以下を見直す。

- 月額プラン価格
- 鑑定回数
- 音声枠数
- 音声枠1枠あたりの上限時間
- 自動音声生成の上限時間
- 使用するAIモデル / 音声モデル
- 音声買い切り価格
- 個別鑑定への案内基準

白音七は「やさしさ」と「継続可能性」を両立するサービスとして設計する。

安すぎて運営継続できない設計にはしない。

## 8. ユーザー向け説明方針

ユーザー向けには、内部DB構造や原価率ではなく、以下を分かりやすく説明する。

- 音声枠1枠は約2分まで
- 音声生成前に必要枠数と残枠を表示する
- 生成済み音声の聞き直しは無制限
- 声・速度・読み上げ文・鑑定内容を変える作り直しは枠を消費する
- システム不具合時は枠を消費しない再生成または個別対応を行う
- 月額特典の未使用枠はperiod終了時に失効する

確認モーダルでは、少なくとも以下を表示する。

- 必要音声枠
- 現在の残り音声枠
- 月額枠 / 買い切り枠の消費内訳
- 聞き直しは無制限であること
- 作り直しは新たに枠を消費すること
- 生成開始後のユーザー都合キャンセルは原則不可であること

## 9. 特商法 / 利用規約 / MOSHに書くべきこと

以下はPR #67時点では仕様メモとして残し、正式文言は利用規約・特定商取引法ページ・MOSH等の表示と合わせて別途整備する。

- 音声枠の定義
- 月額特典枠の付与数
- 月額特典枠は繰り越し不可であること
- 買い切り枠の有効期限
- 音声生成開始後のユーザー都合キャンセル不可
- 生成完了後の自己都合返金不可
- システム不具合時の無料再生成または個別対応
- 10分超の鑑定は自動音声生成対象外であること
- 10分超の鑑定は予約制個別鑑定へ案内すること
- 外部サービス価格改定時に料金・音声枠数・生成方式を見直す可能性

## 10. 外部共有用Lite版

内部設計には `usage_quota` / `usage_logs` / `voice_requests` や原価率30％目標を記載してよい。

ただし、外部AIや外部協力者へ共有する場合は、DB構造や内部原価率は抽象化する。

外部共有用Lite版では、以下のように表現する。

- 音声枠は安全な利用回数管理を行う
- 聞き直しは無制限
- 作り直しは新規生成扱い
- システム不具合時は個別対応
- サービス継続のため、音声生成には上限を設ける

内部テーブル名、実装詳細、原価率、具体的な原価構造は外部共有しない。

## 11. 未決事項

- 不具合判定の具体基準
- 部分返金の有無
- 買い切り枠の有効期限
- 個別鑑定の価格帯
- 誤字修正・軽微修正時の再生成扱い
- 途中切れの判定基準
- 10分超の個別鑑定への正式導線
- MOSH / 特商法 / 利用規約に載せる最終文言

## 12. PR分割計画

### PR #67

音声枠・利用回数管理の仕様ドキュメント追加。

実装は行わない。

### PR #68

DB型・定数・ステータス定義追加。

本番テーブル作成や実消費はしない。

### PR #69

音声枠見積もりAPI追加。

消費なし。確認モーダル用。

### PR #70

フロント確認モーダル追加。

見積もりAPIのみを使い、実消費はしない。

### PR #71

reserve / release / commit の基礎実装。

UI接続なし。

### PR #72

音声生成処理への接続。

成功時 commit、失敗時 release、idempotency 対応。

feature flag の配下で有効化する。

### PR #73

無料再生成・管理 / 調査導線。

`manual_review` や `free_retry` の運用を整備する。

## 13. 今回実装しないこと

- `/result` の保存payload変更
- history保存API変更
- history削除API変更
- 認証まわりの変更
- fincode / MOSH 連携
- 本番DB変更
- 既存の保存済み履歴データ構造変更
- Bedrock第二エンジン接続
- 音声生成処理への接続
