# fincode staging membership migration plan

Status: dry-run planner only; apply intentionally absent

The planner accepts only an explicit bounded target list and a matching allow-list. It hard-denies production, does not scan, does not look up by email, and returns only target digests plus fixed statuses:

- `READY`
- `NO_OP`
- `CONFLICT`
- `MANUAL_REVIEW`
- `INVALID`

An active light/premium proposal is `MANUAL_REVIEW` unless its start/end exactly match a separately trusted period. A lower or equal membership version conflicts. The complete proposed membership v1 record must preserve reviewed `monthly_voice_used`, `extra_voice_remaining`, cancellation state, and source metadata; the planner does not reset or synthesize them. History is outside the migration contract.

Local dry-run sequence after building the fincode bundle:

```text
npm run build:fincode-webhook-handler
node scripts/plan-fincode-membership-migration.mjs <explicit-local-fixture.json>
```

Output contains aggregate counts only. The script performs no AWS call and has no apply mode. A future apply implementation requires a separate instruction, exact staging table verification, conditional per-user writes, a human-approved target allow-list, and rollback evidence.
