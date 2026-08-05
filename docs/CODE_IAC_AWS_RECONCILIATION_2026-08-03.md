# Code / IaC / AWS Reconciliation

Date: 2026-08-03

## Three-way map

| Component | CODE EXPECTS | LOCAL IaC DECLARES | AWS ACTUAL | Verdict |
| --- | --- | --- | --- | --- |
| Browser status API | `zaebx82pyf.../user/status` | outside reading IaC | production bundle still references it; absent from staging account | CROSS_ACCOUNT / LEGACY_ONLY |
| Browser change-plan API | `zaebx82pyf.../subscription/change-plan` | outside reading IaC | production bundle still references it; absent from staging account | CROSS_ACCOUNT / LEGACY_ONLY |
| Legacy Users | Python defaults `shirone7_users` | outside reading IaC | unknown | UNKNOWN |
| Reading Users | `USERS_TABLE_NAME` | `ReadingUsersTable` | request/deep worker bind current physical table | MATCH |
| Reading History | `READING_HISTORY_TABLE_NAME` | `ReadingHistoryTable` | request/status/workers bind current physical table | MATCH |
| Jobs | `READING_JOBS_TABLE_NAME` | `ReadingJobsTable` | request/status/workers bind current physical table | MATCH |
| Light quota | `FINCODE_MEMBERSHIP_QUOTA_TABLE` | `FincodeLightQuotaTable` | table and binding absent | NOT_DEPLOYED |
| Deep quota | `READING_DEEP_QUOTA_TABLE_NAME` | `ReadingDeepQuotaTable` | request/deep worker bind current physical table | MATCH |
| Voice quota | Users counters | no final execution model | legacy AWS actual unknown | UNKNOWN / LEGACY_ONLY |
| Webhook Users | `USERS_TABLE_NAME` | `ReadingUsersTable` | Webhook not deployed | NOT_DEPLOYED |
| Webhook ledger | `FINCODE_WEBHOOK_LEDGER_TABLE` | `FincodeWebhookLedgerTable` | not deployed | NOT_DEPLOYED |
| Customer mapping | dedicated mapping Port | `FincodeCustomerMappingTable` | not deployed | NOT_DEPLOYED |
| Reading HTTP API | `/reading`, `/reading/status` | both routes | both routes deployed to correct Lambdas | MATCH |
| Paid execution | async queue/worker | two queues and mappings | mappings Disabled; async paid false; Bedrock false | FAIL_CLOSED |

## IaC generation drift

| Evidence | Resource count | fincode Webhook | Light quota |
| --- | ---: | --- | --- |
| current local template | 43 | declared | declared |
| current AWS processed template | 32 | absent | absent |

The local template is an implementation candidate, not deployed truth. A future
Change Set must be reviewed as an 11-resource architecture expansion rather
than described as a mere flag change.

## Membership v1 passage

| Runtime | Classification | Evidence |
| --- | --- | --- |
| legacy `/user/status` | UNKNOWN | deployed Lambda/account unavailable |
| reading request membership resolution | LEGACY_COMPAT | `membershipContext.ts` passes raw record to `getMembershipEntitlements()` |
| Light quota mutation | STRICT_V1-dependent | requires version and trusted period fields |
| fincode Webhook write | STRICT_V1 | strict parser and atomic completion Port |
| one-time Voice grant | STRICT_V1 | conditional membership schema/version contract |

The dangerous middle state is therefore real in source: a legacy Premium record
may display as Premium and resolve Light, while the strict quota layer rejects
it for missing membership version or trusted period.

Recommended cutover point: the authenticated membership context should become
STRICT_V1 before any paid request reaches reservation. Legacy records should be
classified or migrated explicitly, not silently upgraded by display logic.

## Product entitlement drift

The product catalog states:

- Light: Light 5, Voice 3;
- Premium: Light 20, Deep 3, Voice 10.

`membershipEntitlements.ts` permits monthly Voice only for active Premium.
Therefore Light Voice 3 is not executable through the shared entitlement layer.

Classification:

```text
P1_PRODUCT_ENTITLEMENT_DRIFT
```

No code was changed in this audit.

## Previous assessment revisions

| Previous assessment | New AWS/browser evidence | Revised verdict |
| --- | --- | --- |
| membership and reading likely split across accounts | public API ID absent from staging; production bundle still points to it; staging roles have no bridge | CROSS_ACCOUNT_CONFIRMED_AT_BOUNDARY |
| `/user/status` may be IDOR | browser sends client `user_id` without Authorization, but target Lambda/auth unavailable | P0_CANDIDATE_NOT_CLEARED, not proven |
| local fincode IaC is ahead of saved runtime evidence | current AWS processed template is 32 resources vs local 43 | DRIFT_CONFIRMED |
| paid reading remains closed | async paid false, both mappings Disabled, Bedrock false | FAIL_CLOSED_CONFIRMED |
| staging status/generate switches were all false in older snapshot | both API switches are now true | PREVIOUS_RUNTIME_STATE_SUPERSEDED |

## New findings

1. Six DynamoDB logical purposes have two physical generations. Current stack
   mapping is unambiguous, but retained tables need a separate data-retention
   inventory before any cleanup.
2. `ReadingJobsTable` has deletion protection but PITR is disabled.
3. API Gateway routes have no authorizer; the Node Lambda Bearer verifier is the
   security boundary. That is intentional for current source, but it makes
   deployed artifact/source parity a release-critical test.

## P0 accounting

- Previous P0 revised: cross-account boundary is confirmed, exact legacy table
  and authentication implementation remain unknown.
- New P0: none declared without the missing legacy evidence.
- Cleared P0: none.
- P0 security candidate: `/user/status` ownership enforcement.

## Conclusion

Current reading staging is internally single-account and fail-closed. The
overall product is not yet reconciled because the live membership API is in an
unavailable account and no runtime bridge or migration exists.
