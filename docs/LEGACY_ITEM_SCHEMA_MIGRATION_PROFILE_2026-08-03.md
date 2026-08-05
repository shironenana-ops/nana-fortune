# Legacy item schema migration profile

Date: 2026-08-03

## Scope and method

This profile records the read-only inspection of the existing production data source of truth in the legacy account. No item body, personal information, credential, or secret was written to a report. The inspection used projection-only reads and aggregate counts. No AWS mutation was performed.

## Observed generations

| Store | Count | Observed generation | Canonical generation |
|---|---:|---|---|
| `shirone7_users` | 5 | legacy membership fields | 0/5 had `membership_schema_version`, `membership_version`, `membership_source`, or `membership_updated_at` |
| `shirone7_history` | 28 | legacy history metadata | 0/28 had canonical `schema_version` or resolved reading-mode metadata |

All five user records contained `plan`, `subscription_status`, `deep_enabled`, voice allowance counters, and `current_period_end`. None contained `current_period_start`. The safe category counts were one free/inactive record, one light/active record, and three premium/active records. Existing counters were non-negative, but some values exceeded the current canonical product limits; those records require an explicit human migration policy rather than silent truncation.

All 28 history records contained status, source, and timestamps. They did not contain the canonical reading-mode fields needed to classify every historical result automatically.

## Canonical transformation

The local migration planner in `src/server/fincode/canonicalMigration.ts` applies these rules:

- already-canonical records are a no-op;
- a free record can be transformed without inventing a contract period;
- an active paid record requires trusted `current_period_start` and `current_period_end` values;
- existing usage and one-time voice allowance are preserved;
- contradictory states, unknown plans, malformed periods, and counters exceeding the canonical limit are sent to manual review;
- history migration adds metadata only and never copies or logs the result body;
- a history item whose generation cannot be determined is sent to manual review.

## Migration decision

- In-place, conditionally versioned backfill of the existing tables: **required**.
- New users or history source of truth: **forbidden**.
- Destructive replacement or silent counter reset: **forbidden**.
- Automatic paid-user migration before a trusted period source is available: **blocked**.
- Automatic classification of all legacy history: **blocked** where canonical generation cannot be proven.

The existing `shirone7_users` and `shirone7_history` tables remain the production data sources of truth.
