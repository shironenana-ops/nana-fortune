# Membership Source-of-Truth Options

Date: 2026-08-03

## Decisions that AWS actual can and cannot answer

Confirmed:

- public membership APIs are outside `READING_STAGING_ACCOUNT`;
- reading staging uses its own `ReadingUsersTable` and has no cross-account IAM;
- local fincode Webhook is designed to update the reading stack Users table;
- one DynamoDB transaction cannot atomically update tables in two accounts;
- fincode Webhook and its mapping/ledger/quota tables are not deployed.

Not confirmed:

- physical legacy Users/History/Voice resources;
- ownership checks in `/user/status` and `/subscription/change-plan`;
- legacy user count, schema quality and migration volume;
- which account is approved as the future production trust boundary.

## Option comparison

| Criterion | A: legacy Users remains authority | B: move authority to reading account | C: new unified production stack; staging remains fixture |
| --- | --- | --- | --- |
| Atomicity | poor across accounts; requires redesign | strong after migration | strong in final stack |
| Security | cross-account role/API boundary added | one account after cutover | one explicit production boundary |
| Migration risk | low Users migration, high integration risk | high identity/login migration | high but phaseable |
| Rollback | legacy continuity is easy | dual-read/cutback required | blue/green style possible |
| Existing user continuity | strongest initially | requires verified mapping | requires verified mapping |
| Voice compatibility | legacy path easiest, quota remains weak | Voice must migrate | Voice can be redesigned before cutover |
| fincode compatibility | ledger and Users cannot share one transaction across accounts | strong | strongest if co-located |
| Operational simplicity | poor | medium | strongest end-state |
| Implementation size | medium | large | largest |

## Option A

Keep the legacy account as membership authority and let reading call it through
a narrowly scoped role or authenticated internal API.

This preserves users but cannot satisfy the current design goal of one atomic
DynamoDB transaction for membership, Light quota and Webhook ledger unless all
three are moved to the legacy account. A cross-account call also creates a new
availability and IAM boundary.

## Option B

Move paid membership authority to `ReadingUsersTable`, then migrate login,
status, history and Voice consumers.

This matches the local Webhook transaction design and enables co-located Users,
Light quota, mapping and ledger. It is unsafe to select before the legacy schema
and user population are inspected.

## Option C

Keep current reading staging as isolated test infrastructure. Build the eventual
production reading/membership stack in one deliberately chosen account, migrate
legacy identity and history in stages, then cut over the public site.

This is the cleanest end-state and preserves staging isolation. It has the
largest implementation scope but avoids treating a staging account as a
production authority by accident.

## Provisional recommendation

Recommend **Option C as the architecture target**, with Option B's migration
mechanics if `READING_STAGING_ACCOUNT` (or its production counterpart) is chosen
as the final host.

This recommendation is provisional because the legacy account has not been
read. Do not choose the production account or migrate data until these are
known:

1. legacy account identity and region;
2. exact login/status/change-plan/Voice Lambda bindings;
3. user and history key/schema inventory without item-body disclosure;
4. ownership/authentication behavior of both public membership endpoints;
5. a stable identity mapping and rollback plan.

## Required migration components

- strict membership-v1 classification report;
- deterministic user ID mapping;
- paid-period source and version mapping;
- Voice monthly/extra balance reconciliation;
- history ownership migration or federation contract;
- dual-read validation period;
- cutover and rollback checkpoints;
- removal of public client-supplied `user_id` as an authority input.

## Source-of-truth verdict

```text
ARCHITECTURE OPTIONS READY
FINAL ACCOUNT DECISION BLOCKED BY LEGACY AWS ACTUAL
```
