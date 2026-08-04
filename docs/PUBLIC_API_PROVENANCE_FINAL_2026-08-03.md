# Public API Provenance Final

Date: 2026-08-03

## Verdict

```text
PUBLIC_API_CONFIRMED_OTHER_KNOWN_ACCOUNT
```

`zaebx82pyf` is a currently existing API Gateway HTTP API in
`LEGACY_ACCOUNT`. It is not a deleted generation and no third account is
needed to explain it.

## Evidence

| Evidence | Status | Result |
|---|---|---|
| Exact API ID in `nana-legacy-readonly` | CONFIRMED | `zaebx82pyf` exists |
| API name | CONFIRMED | `shirone7-checkout-api` |
| Created date | CONFIRMED | 2026-04-06 JST |
| Public routes | CONFIRMED | `/checkout`, `/user/status`, `/subscription/change-plan`, `/stripe/webhook` |
| Integrations | CONFIRMED | legacy checkout, user-status, change-plan and webhook Lambdas |
| Public frontend references | CONFIRMED | `members.astro` and `premium.astro` still call this API |
| Reading staging account | CONFIRMED | exact API ID absent |
| CloudFormation ownership tags | CONFIRMED | absent on this API |
| CloudTrail create/delete event | UNKNOWN | creation predates the searchable event-history window |

The API was created before its first repository reference in `0194a6e` on
2026-06-10. Git history therefore proves adoption by the frontend, not API
creation provenance.

## Security boundary consequence

The exact public API has Gateway authorization `NONE`. The public frontend
sends a client-controlled `user_id` to `/user/status` and
`/subscription/change-plan` without an Authorization header. Their exact
Lambda integrations have a Users-table binding but no standard
`SESSION_TOKEN_SECRET` configuration.

This confirms that the observed public membership path does not use the new
server-resolved Bearer-token boundary. Deployed package contents were not read,
so handler-internal behavior beyond the observable boundary remains UNKNOWN.
The two routes must remain closed or be replaced before paid production use.

## Reconciliation correction

The earlier statements in the 2026-08-03 audit set that the API ID was absent
from both known accounts are superseded by this focused lookup. No AWS resource
was changed and no production API request was sent.
