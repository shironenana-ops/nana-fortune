# Production Source-of-Truth Decision Input

Date: 2026-08-03

## Account topology now evidenced

| Boundary | Evidence |
| --- | --- |
| reading staging | separate account, self-contained 32-resource stack |
| legacy data/Voice | `LEGACY_ACCOUNT` with `shirone7_users`, History, Voice Lambdas and bucket |
| public membership API | API ID `zaebx82pyf`, absent from both known accounts |

The current evidence supports at least three boundary candidates. It does not
support assuming that the legacy data account owns the API used by the public
site.

## Strategy comparison

| Criterion | Legacy account as core | Reading-side account as core | New clean production account |
| --- | --- | --- | --- |
| Existing users migration | lowest if public API is repointed | full migration | full migration |
| Existing history migration | lowest | required | required |
| Voice migration | hardening in place | migrate and redesign | migrate and redesign |
| Auth migration | legacy preserved, public API owner unresolved | required | required |
| DNS/API cutover | required because current API owner is unknown | required | required |
| fincode placement | can be co-located after redesign | matches local IaC design | clean co-location |
| Atomic DDB transaction | possible if all payment tables are placed here | possible | possible |
| Rollback | strongest legacy rollback | dual-read/cutback needed | blue/green possible |
| Operational simplicity | medium after cleanup | medium | strongest end-state |
| Security isolation | legacy roles need hardening | staging cannot become production accidentally | strongest if designed explicitly |

## Option C status

Option C remains the preferred architecture target:

```text
staging = isolated fixture
future production = one intentionally selected account containing
membership + reading + fincode transaction participants
```

The exact production account cannot yet be selected because the owner and
runtime of `zaebx82pyf` are still missing.

## Migration readiness

Known migration inputs:

- Users key: `user_id`;
- History key: `user_id` + `history_id`;
- both legacy tables are active and PAY_PER_REQUEST;
- both lack PITR, deletion protection and tags;
- Voice is bound to those same tables;
- Light quota and fincode ledger/mapping are not deployed in staging.

Unknown inputs:

- legacy record schema distribution and count;
- public API owner and its actual Users table;
- public status/change-plan ownership checks;
- stable mapping between payment customer reference and authoritative user;
- required history retention/cutover volume.

```text
Migration decision ready: NO
Architecture target ready for human review: YES
```

## Required next decision sequence

1. identify the account owning `zaebx82pyf`;
2. audit its status/change-plan Lambda and table bindings;
3. decide which account is the production trust boundary;
4. approve schema-only/item sampling separately if migration sizing needs it;
5. design migration, dual-read validation and rollback;
6. only then implement entitlement/UI/runtime changes.
