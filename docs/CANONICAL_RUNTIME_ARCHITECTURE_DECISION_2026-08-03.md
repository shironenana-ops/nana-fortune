# Canonical Runtime Architecture Decision Input

Date: 2026-08-03

## Decision status

The target architecture is ready for a human account decision. The recommended
production core is `LEGACY_ACCOUNT`, because it already owns the public API,
production Users/History data and the live Voice runtime. The Reading staging
account remains an isolated staging environment and must not become a second
production source of truth.

This is a recommendation only; no migration or deployment is authorized.

## Unified domain map

| Domain | Current public/runtime | Legacy | Staging | Local IaC | Canonical target | Migration needed |
|---|---|---|---|---|---|---|
| Authentication / session | login API plus browser storage | login/session Lambda | fixture-token boundary | reading auth contract | one server-resolved identity contract | yes |
| Users / membership | public legacy status API | `shirone7_users` | test ReadingUsers | membership-v1 resources | production Users in canonical account | yes |
| History | public legacy history | `shirone7_history` | ReadingHistory | canonical history/jobs | one production History ownership model | yes |
| Reading light | public path not safely open | none canonical | async worker disabled | implemented | canonical production reading stack | deploy/migrate |
| Reading deep | public path not safely open | none canonical | async worker disabled | implemented | canonical production reading stack | deploy/migrate |
| Voice upload/result | legacy runtime | bound to legacy Users/History/S3 | none | replacement contract only | atomic canonical model in production core | redesign/migrate |
| Voice quota | legacy Users counters | non-atomic observed model | entitlement fields only | atomic target contract | canonical Users plus ledger transaction | yes |
| Light quota | not publicly canonical | no trusted period model | schema/runtime incomplete | local model ahead | contract-period quota in canonical stack | yes |
| Deep quota | not public | absent | staging table | implemented | same contract semantics as product decision | yes |
| Payment customer mapping | public Stripe-era path | legacy billing | not deployed | fincode mapping designed | fincode canonical mapping | replace |
| Payment ledger | legacy Stripe webhook | legacy webhook | not deployed | fincode ledger designed | one canonical fincode ledger | replace |
| Webhook | Stripe-era public route | legacy webhook | not deployed | fincode verified webhook | fincode verified server-side grant only | replace |
| Purchase Intent | TEST-only local path | absent | not deployed | implemented locally | shared application contract | deploy |
| Idempotency | split by feature | legacy-specific | Reading table | implemented | one contract, environment-local data | migrate |
| Rate limit / concurrency | split | legacy behavior | implemented, disabled | implemented | canonical policies from one IaC generation | deploy |
| Failure recovery | incomplete across old flows | Voice partial-success risk | Reading recovery implemented | fincode recovery designed | atomic transaction plus recoverable jobs | redesign |
| Audit log | fragmented | service logs | CloudWatch logs | safe logging contracts | one redacted audit contract | consolidate |

## Environment model

```text
Canonical IaC and contracts
  staging: isolated test data + MockPaymentProvider/FincodeTestPaymentProvider
  production: canonical Users/History + FincodeProdPaymentProvider
```

Both environments share schema, membership and quota contracts, API/auth
boundaries, idempotency, ledger semantics, failure recovery and IaC topology.
They separate data, secrets, resource names and external credentials.

## Non-negotiable gates

- The frontend must stop hard-coding legacy membership endpoints.
- Public membership status and mutations must use server-resolved identity.
- Production Users, entitlement, quota, ledger and History writes must be
  transactionally compatible in one account/region boundary.
- Staging must remain isolated but structurally equivalent.
- Local IaC cannot be treated as deployed evidence.
- Existing production data is migrated or explicitly preserved; it is never
  silently abandoned.

## P0 accounting

- Confirmed: 2 -- split production source-of-truth; public membership path does
  not use the trusted authentication boundary.
- Unresolved: 2 -- exact deployed Voice handler parity/atomicity; final
  one-time-voice grant placement and migration behavior.
