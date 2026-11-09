# Token refresh and session rotation

How `refreshHankoAccessToken` reports failures, how the process-local refresh coordinator works, and what the host still owns.

## Refresh failures

`refreshHankoAccessToken` uses same-origin discovery and refuses HTTP failures.
It retains the existing `error` string contract (`HankoRefreshTokenError`, or
the supplied `errorCode`) and adds allowlisted `refreshFailure` metadata:

| Category | Meaning | Safe to retry the same refresh token? |
| --- | --- | --- |
| `missing_refresh_token`, `configuration` | Missing token or invalid client configuration | No; correct configuration or sign in. |
| `discovery_unavailable` | Discovery transport or HTTP failure, before token exchange | Only when `retryable` is `true`; use bounded backoff. |
| `discovery_invalid` | Invalid metadata or issuer/endpoint substitution | No; review trust configuration. |
| `rejected_grant` | Refresh endpoint returned HTTP 400 with `invalid_grant` | No; require sign-in. |
| `client_configuration` | Client authentication/authorization rejected | No; correct client configuration. |
| `provider_unavailable` | Refresh endpoint returned 429 or a server error | No automatic replay: an upstream may already have consumed the token. |
| `refresh_outcome_unknown`, `invalid_response` | Lost POST response, unexpected rejection or invalid success packet | No; consumption is unknown, so require sign-in or an independently verified recovery. |
| `coordinator_capacity` | Local coordinator refused new work before exchange | `retryable: true`; no token was submitted. |
| `session_invalidated` | Host invalidated the tracked lineage | No; never restore this result. |

Metadata contains only `category`, `stage`, `retryable` and an optional numeric
`httpStatus`. Provider bodies, exception messages and credentials are never
included. A network timeout **after POST submission** is not evidence that the
provider failed to rotate the token. The helper never automatically retries.
For compatibility, an errored helper result still retains old credential fields:
**presence of `accessToken` does not establish success; check `error` first.**
An application must suppress access credentials from errored public sessions.
Only a definitely pre-exchange failure permits retaining the private refresh
token for a later, bounded retry. Never log a complete result object.

## Session ownership and rotation

Create one `createHankoRefreshCoordinator()` per server process and call its
`refresh(token, client, options)` method from the JWT callback. It coalesces
concurrent calls for the same issuer/client/credential/refresh lineage and
briefly reuses completed provider-field results for requests carrying an old
cookie. Caller-specific JWT fields are not shared. Keys are SHA-256 digests;
credential-bearing results remain memory-only and must not be logged.

The default completed-result window is ten seconds, at most the returned access
token's remaining lifetime; `reuseWindowMs` accepts 1–60000 ms. `maxEntries`
defaults to 256 (range 1–4096). Expired completed entries are pruned on use.
Pending entries are never evicted to make room: capacity exhaustion fails
closed before exchange. Failed outcomes are retained too, preventing immediate
blind replay after an ambiguous POST. This bounded cache is not a permanent
guarantee against replay after eviction, expiration or restart.

`await coordinator.invalidate(token, client)` invalidates an in-flight or
completed lineage and installs a short-lived tombstone. It returns `false`
when no key can be constructed or capacity prevents a new tombstone. `clear()`
invalidates tracked results, including pending work. Neither method revokes a
provider session, an encrypted application cookie or another server's cache.
The host must fence logout/account replacement against late responses with its
own session ownership/version or revocation mechanism.

The coordinator is **process-local**, not a distributed lock or session store.
Multiple replicas, overlapping rollouts, restarts and concurrent tabs can
present old cookies to different processes. Use a shared session/rotation owner
for that topology, or enforce a documented single-process topology and invalidate
old application sessions on process replacement. Do not relax single-use token
rotation to hide duplicate refreshes. A browser promise alone cannot coordinate
server requests or replicas.
