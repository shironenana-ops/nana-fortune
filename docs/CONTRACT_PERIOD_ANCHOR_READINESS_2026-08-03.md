# Contract period anchor readiness

Date: 2026-08-03

## Source decision

The canonical source contract remains `FincodeSubscriptionPeriodSource`. A period is usable only when that source returns `RESOLVED` with internally consistent start, end, period digest, ownership mapping, and source version. Process time, migration time, `updated_at`, login time, history creation time, calendar month, or an assumed number of days are not accepted anchors.

## Existing-record result

The prior projection-only inventory found five legacy Users records: one free/inactive and four active paid records. All five had `current_period_end`; none had `current_period_start`. No existing verified payment/membership record available to this task supplied a trustworthy missing start.

| Result | Count | Meaning |
|---|---:|---|
| `RESOLVED` | 0 | no paid legacy record has a complete trusted interval |
| `NOT_AVAILABLE` | 4 | paid records must not be automatically migrated |
| `CONFLICT` | 0 | no conflicting anchors were asserted |
| `UNAVAILABLE` | 0 | no provider outage was converted into an anchor |
| not required | 1 | free/inactive record needs no paid contract period |

No raw item, identity, PII, or secret is recorded here.

## Readiness

`PARTIAL`: the source contract and fail-closed classifications are ready, but the four paid legacy records require a future verified source or manual review. Their starts must not be inferred. This isolation does not prevent fincode TEST work because TEST must not migrate or grant those production records.
