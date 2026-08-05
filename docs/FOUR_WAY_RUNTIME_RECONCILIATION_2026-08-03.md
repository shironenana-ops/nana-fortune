# Browser / Code / IaC / AWS Runtime Reconciliation

Date: 2026-08-03

## Source-of-truth map

| Concern | Public browser | Legacy AWS | Reading staging AWS | Local IaC | Current SoT |
| --- | --- | --- | --- | --- | --- |
| Login identity | login route elsewhere in source | `shirone7-login` -> `shirone7_users` | staging fixture token/user | no public login migration | SPLIT |
| Membership | `zaebx` status API | `shirone7_users` | independent ReadingUsers | Webhook targets ReadingUsers | SPLIT |
| Plan/status | client sends `user_id` | separate checkout API exists | request reads ReadingUsers | membership-v1 planned | SPLIT |
| Contract period | returned/displayed when present | item schema unknown | strict period expected, fixture state | strict membership-v1 | UNKNOWN |
| Light quota | feature not usable | no dedicated table found | not deployed | FincodeLightQuota declared | NOT_DEPLOYED |
| Deep quota | feature not usable | no dedicated table found | dedicated Deep table | declared | CONFIRMED staging only |
| Monthly Voice | counter display | Users counters | no Voice runtime | Users mutation planned | SPLIT |
| Extra Voice | counter display | Users counter | no Voice runtime | idempotent grant planned | SPLIT |
| History | legacy UI/API | `shirone7_history` | separate ReadingHistory | separate table | SPLIT |
| Payment mapping | old Stripe-era flow | no fincode mapping found | not deployed | mapping table declared | NOT_DEPLOYED |
| Payment ledger | none | no fincode ledger found | not deployed | ledger table declared | NOT_DEPLOYED |

## Four-way component comparison

| Component | Browser ACTUAL | CODE | IaC | AWS ACTUAL | Verdict |
| --- | --- | --- | --- | --- | --- |
| Member status | `zaebx.../user/status`, no Authorization nearby | client `user_id` query | outside new IaC | target API absent from both known accounts | UNKNOWN / SPLIT_SOURCE_OF_TRUTH |
| Change plan | `zaebx.../subscription/change-plan`, no Authorization nearby | client `user_id` body | outside new IaC | target API absent; analogous legacy API exists | UNKNOWN / SPLIT_SOURCE_OF_TRUTH |
| Membership Users | legacy response | legacy defaults and new repository coexist | ReadingUsers | legacy and staging each have Users | SPLIT_SOURCE_OF_TRUTH |
| Light quota | unavailable | strict subscription-period lifecycle | local table declared | not deployed | NOT_DEPLOYED |
| Deep quota | unavailable | JST calendar lifecycle | table declared | staging table deployed, worker off | MATCH / FAIL_CLOSED |
| Voice quota | balance display | legacy weak flow plus new grant design | final runtime incomplete | legacy counters connected; new path not deployed | LEGACY / DRIFT |
| History | legacy history pages | old and new repositories | separate ReadingHistory | legacy and staging tables separate | SPLIT_SOURCE_OF_TRUTH |
| fincode Webhook | no public runtime | local implementation | 43-resource template | absent from 32-resource runtime | LOCAL_IAC_AHEAD_OF_STAGING_RUNTIME |

## Previous assessment correction

Previous assessment:

```text
public membership API is outside reading staging and likely in legacy account
```

New evidence:

```text
the approved legacy account contains the expected data and analogous routes,
but not API ID zaebx82pyf
```

Revised verdict:

```text
PUBLIC_API_ACCOUNT_UNKNOWN
LEGACY_DATA_ACCOUNT_CONFIRMED
READING_STAGING_ACCOUNT_CONFIRMED
```

## Security accounting

- P0 candidate: public user-status ownership boundary.
- P0 candidate: public change-plan ownership boundary.
- P0 confirmed: 0.
- P0 cleared: 0.

The legacy-account analogous routes have no Gateway authorizer and no standard
session-secret configuration, but deployed source was not read. They remain
`PARTIAL`, not a proven exploit.

## Overall verdict

```text
LOCAL_IAC_AHEAD_OF_STAGING_RUNTIME
LEGACY_ACCOUNT_RUNTIME_MAPPED
PUBLIC_API_OWNER_STILL_UNKNOWN
SOURCE_OF_TRUTH_DECISION_NOT_READY
```
