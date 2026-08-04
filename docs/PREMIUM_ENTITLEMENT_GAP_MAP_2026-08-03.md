# Premium entitlement gap map

Date: 2026-08-03

## Expected plan

```text
Premium
├─ Light: 20 per trusted subscription period
├─ Deep: 3 per JST calendar month
└─ Voice: 10 per trusted subscription period
```

`src/lib/billingPlans.ts` is the storefront catalog. It correctly advertises
20/3/10. Execution state is intentionally distributed by usage type and must
not be reconstructed from the catalog at request time.

## Gap matrix

| Capability | Expected source | Current source/runtime | UI | Gap |
| --- | --- | --- | --- | --- |
| Membership | membership v1 Users record with period/version/source | legacy Users fields are still accepted by site and server entitlement helper | Premium label can render | strict and legacy states are not distinguished |
| Light 20 | `FincodeLightQuotaTable`, period ID, membership version | local implementation exists; saved deployed snapshot lacks the table; flags off | `/premium/light` is storefront-only | no end-to-end connection |
| Deep 3 | `ReadingDeepQuotaTable`, JST month; `deep_enabled` gate | source, IaC and tests exist; worker/Bedrock disabled | always “準備中” | UI/runtime opening missing |
| Voice 10 | Users monthly counters for membership display; safe request ledger still undecided | legacy check/consume is non-atomic | balance only, Voice page is preparation copy | no safe execution entry |
| Voice +1 | dedicated purchase ledger + Users transaction | local adapter/test only | TEST completion explicitly grants nothing | no table/IAM/Webhook/account placement |
| Result/history | new `ReadingHistoryTable` for async text reading | legacy History API/table remains the site UI source | old history pages | stores are not unified |

## Light trace

```text
members
  -> /premium/light                         PRESENT
  -> authenticated membership fetch        MISSING
  -> Bearer-token request API               MISSING IN UI
  -> premium resolves to light              IMPLEMENTED
  -> trusted period/version                 REQUIRED, LEGACY RECORD MAY MISS
  -> FincodeLightQuotaTable reserve         IMPLEMENTED LOCALLY
  -> SQS Light worker                       IMPLEMENTED, DISABLED IN STAGING
  -> Bedrock                                IMPLEMENTED, DISABLED IN STAGING
  -> history/result                         IMPLEMENTED IN NEW STORE
  -> UI polling/result navigation           MISSING
```

The server does correctly allow active Premium to use Light:
`src/lib/readingModeResolution.ts:45-59`. The observed inability is not caused
by `plan === "light"`; it is caused by frontend non-integration plus missing
strict membership/period/runtime activation.

## Deep trace

```text
members
  -> Deep panel                             PRESENT BUT NOT A LINK
  -> /premium/deep                          PRESENT, STOREFRONT ONLY
  -> explicit requested_mode=deep           SERVER IMPLEMENTED
  -> premium + active + deep_enabled         IMPLEMENTED
  -> JST-month quota 3 reserve               IMPLEMENTED
  -> Deep queue/worker/Bedrock                IMPLEMENTED, DISABLED
  -> complete/release/history                IMPLEMENTED
  -> polling/result UI                       MISSING
```

`deep_enabled` is not the count and is not dead. It is a current master gate.
The count belongs to the dedicated Deep quota record.

## Voice trace

```text
members balance
  -> /premium/voice                         PAGE EXISTS
  -> product choice: upload consultation/TTS UNRESOLVED
  -> authenticated start                    NOT EXPOSED
  -> atomic reserve                          MISSING IN LEGACY FLOW
  -> S3/Transcribe                           LEGACY IMPLEMENTATION EXISTS
  -> atomic consume/release                  MISSING
  -> history/result                          LEGACY IMPLEMENTATION EXISTS
```

The present balance is only a display of Users counters. It is not proof that a
safe Voice execution route is available.

## Required gates before opening

1. Choose the authoritative Users account and migrate a dedicated non-personal
   staging identity into membership v1.
2. Add an authenticated membership/quota status facade.
3. Deploy/verify trusted period and Light quota before enabling Light.
4. Connect Light UI and polling; run one successful and failure-recovery E2E.
5. Connect Deep UI only after the existing Deep staging graduation passes.
6. Decide whether the public Voice product is uploaded consultation, TTS, or
   separate named products.
7. Replace the legacy Voice check/decrement with reserve/complete/release.
8. Place the one-time purchase ledger beside authoritative Users before
   deploying `voice_single +1`.

## Verdict

```text
Premium entitlement policy: DEFINED
Premium entitlement persistence: SPLIT
Premium entitlement UI: INCOMPLETE
Premium paid-reading runtime: FAIL-CLOSED
Premium safe public availability: NOT READY
```
