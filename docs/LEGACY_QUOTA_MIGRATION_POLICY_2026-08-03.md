# Legacy quota migration policy

Date: 2026-08-03

## Policy

Legacy allowance values are never silently clamped, reset, or rewritten to make them fit the current catalog.

| Classification | Conditions | Action |
|---|---|---|
| `MIGRATABLE` | shape valid, trusted period resolved when paid, legacy limit equals canonical limit, used is within limit | preserve usage and extra allowance |
| `MANUAL_REVIEW` | anchor unavailable, legacy limit differs, or usage exceeds canonical limit | isolate; preserve evidence; no entitlement mutation |
| `BLOCKED` | period sources conflict/unavailable or entitlement policy conflicts | stop the record |
| `UNKNOWN_SCHEMA` | malformed/negative counters, used greater than legacy limit, or unknown shape | stop and classify manually |

For over-limit usage, the safe options are a documented grandfathering decision for the verified existing period or waiting for a verified renewal boundary. The planner does not choose between them. The current counter and legacy limit remain evidence and are not forced into the canonical counter.

Light, Deep, and monthly Voice use the same trusted contract-period boundaries. `extra_voice_remaining` is preserved independently and is never converted into a monthly allowance.
