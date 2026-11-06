# HankoShell TypeScript ADK

Application authentication, backend adapters and reusable account screens for HankoShell.

Go and TypeScript share a version for each qualified integration delivery. See the [coordinated version policy](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/versioning.md).
Use Node 22 or 24. Install the qualified public release:

```sh
npm install https://github.com/Alien6-Studio/hankoshell-typescript-adk/releases/download/v0.7.1/alien6-studio-hankoshell-typescript-adk-0.7.1.tgz
```

[![CI](https://github.com/Alien6-Studio/hankoshell-typescript-adk/actions/workflows/ci.yml/badge.svg)](https://github.com/Alien6-Studio/hankoshell-typescript-adk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Configure

```text
HANKO_ISSUER=https://auth.example.test/realms/example
HANKO_CLIENT_ID=example-app
HANKO_CLIENT_SECRET=<server-only secret, when required>
HANKO_AUDIENCE=example-api
```

Keep client secrets in your application’s secret mechanism and out of browser bundles.

## Auth.js

For a complete Node.js application session, use shared storage and the supported
integration. Install the optional `next-auth` and `pg` peers in the host:

```ts
import NextAuth from "next-auth";
import { Pool } from "pg";
import { loadHankoClientConfig } from "@alien6-studio/hankoshell-typescript-adk";
import { createHankoAuthJsSession } from "@alien6-studio/hankoshell-typescript-adk/authjs/session";
import { createHankoPostgresSessionStore } from "@alien6-studio/hankoshell-typescript-adk/sessions/postgres";

const integration = createHankoAuthJsSession({
  client: () => loadHankoClientConfig(process.env),
  audience: process.env.HANKO_AUDIENCE!,
  secret: process.env.AUTH_SECRET!,
  store: createHankoPostgresSessionStore(new Pool({ connectionString: process.env.HANKO_SESSION_DATABASE_URL })),
});
export const { handlers, auth, signIn, signOut } = NextAuth(() => integration.config());
```

Apply `HANKO_POSTGRES_SESSION_SCHEMA` through the host's migration procedure before
deployment. Give the runtime database identity CRUD rights on this table only;
keep the connection string and at least 32-byte `AUTH_SECRET` server-side. All
replicas share these values. Construct the integration once per application
process. A projected client secret can be read in the `client` callback for each
exchange; issuer and client identity remain fixed for an existing session.

The adapter handles PKCE, state, nonce, encrypted server-side token storage,
coordinated renewal and sign-out revocation. Auth.js cookies contain only a random
session pointer. Browser sessions expose a short-lived access token, its expiry,
verified identity and role hints; never a refresh token or logout hint. API guards
independently authorize every operation. Business account binding remains explicit.

Mount Auth.js handlers at `/api/auth/[...nextauth]`. Keep route handlers on the Node
runtime, and use the same-origin Auth.js sign-in/sign-out actions for CSRF protection.
Do not redirect automatically on every API 401 or 403. `ReauthenticationRequired`
offers a user-initiated sign-in; `SessionTemporarilyUnavailable` offers retry.
The integration can also expose `callbacks` for an existing host configuration.
Use `integration.logoutToken(privateJwt)` only server-side before revocation when
implementing provider logout. A custom logout route must await
`integration.revoke(privateJwt)` before reporting success; a storage failure must
not be presented as confirmed sign-out. Schedule deletion of expired rows using
`DELETE FROM hanko_sessions WHERE expires_at < (extract(epoch FROM now()) * 1000)`.

`createHankoAuthJsProvider` remains available for applications that intentionally
own their session lifecycle. Its smaller [cookie-session example](examples/authjs-session.ts)
uses process-local coordination and does not provide shared storage or distributed
revocation. Do not use it as the multi-replica reference.

Run `HANKO_TEST_DATABASE_URL=<empty disposable database> npm run test:session-flow`
to qualify real OIDC/PKCE, Auth.js cookies, PostgreSQL, concurrent independent
instances, restart and logout with synthetic identities. See the
[0.7.0 milestone](docs/releases/0.7.0.md).

## Passport / NestJS

```ts
import { Strategy } from "passport-jwt";
import {
  loadHankoResourceServerConfig,
  createHankoPrincipal,
} from "@alien6-studio/hankoshell-typescript-adk";
import { createHankoJwtStrategyOptions } from "@alien6-studio/hankoshell-typescript-adk/passport";

const config = loadHankoResourceServerConfig(process.env);
const strategy = new Strategy(
  createHankoJwtStrategyOptions(config),
  (claims, done) => {
    try {
      done(null, createHankoPrincipal(claims, config.issuer, config.audience));
    } catch (error) {
      done(error);
    }
  },
);
```

Passport performs signature verification before the callback. Calling
`createHankoPrincipal` by itself does not authenticate a token. Install the
optional `passport-jwt` peer for this entry point.

After verification, `requireHankoApplicationAccess(principal, audience, ["staff", "admin"])`
requires an application role and throws `HankoAccessError` with a safe category
and status 403. It never substitutes realm-wide roles for application roles.
Malformed or ambiguous organizations fail closed. Preserve application-specific
business binding separately, using the verified issuer and subject, never an
automatic email merge. `resolveHankoApplicationAccess` retains its legacy mapping
for compatibility and should not be used as an implicit staff authorization gate.

`HankoApplicationOrganizationClient.memberships()` lists approved organization
choices. `selectMembership(id)` returns a bounded context access token; it does
not grant new membership. Retain the original login token server-side for later
selections. For a distinct sign-in client and API audience, explicitly supply
`{ clientId: "example-web" }` as the fourth argument to
`requireHankoApplicationAccess`. A selected context must match that authorized
party, subject, organization path, policy version and application roles. A malformed
context cannot fall back to global roles.

## React account screens

Use **headless IAM with host-owned UI components** for application screens.
The ADK owns account and organization loading, mutations and permission checks;
the application owns its Next.js routes, navigation and design system.

`HankoIdentityScreen` from `/identity/react` accepts a required `ui` adapter for
the application's buttons, fields, selects, cards and member lists. It injects
no CSS, theme variables, navigation frame or iframe and needs only React.
Bind your existing shadcn/ui components using [the reference adapter](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/examples/shadcn-ui.tsx),
or bind another design system through the same typed contract. No second copy
of shadcn or Radix is installed by the ADK.

Headless screens support `en`, `fr`, `es`, `de`, `it`, `pt-BR`, `ar` and `he`.
Regional tags such as `fr-CA` and `he-IL` resolve to the supported language;
unknown tags fall back to English. `/identity/react` exports
`resolveHankoIdentityLocale`, `hankoIdentityLocales` and `hankoIdentityDirection`.
Use the direction helper on the host's page container for Arabic and Hebrew.
The older themed `/react` wrapper retains its English/French locale contract.

```tsx
"use client";
import { HankoIdentityScreen } from "@alien6-studio/hankoshell-typescript-adk/identity/react";
import { createHankoIdentityClient } from "@alien6-studio/hankoshell-typescript-adk/identity";
import { hankoIdentityUI } from "./hanko-identity-ui";

const controller = createHankoIdentityClient({ endpoint: "/api/account" });
export function OrganizationPage({ subject }: { subject: string }) {
  return (
    <HankoIdentityScreen
      subject={subject}
      controller={controller}
      page="organizations"
      ui={hankoIdentityUI}
      locale="fr"
    />
  );
}
```

Pages cover profile, organizations, access and security. Organization screens
include details, members, invitations, role changes and removal when the backend
authorizes them. `editableFields` narrows organization fields to those the product
supports; the server handler enforces this allowlist too. Unsupported actions stay
hidden, and read-only access is explicit. Selecting an organization to administer
does not switch the application's active tenant.

For custom layouts, use `useHankoAccount`, `useHankoOrganization` and
`useHankoIdentityMutation`. These retain validation, cancellation and mutation state.
`HankoIdentityView` accepts an already-loaded, subject-bound account.

The `/react` entry also provides `HankoIdentityPage` for the same native integration
with live Theme Builder titles and descriptions: pass `ui`, `theme` and `page`.
`HankoIdentityPortal` remains available for standalone themed portals. Applications
should use native pages. Only these themed adapters require Theme Builder.

`createHankoIdentityHandler` from `/identity/server` exposes this same-origin
endpoint. Its `authorize(request)` callback must verify the current session and
return `{ subject, controller }`. Implement that controller against your existing
server-authorized APIs; `createHankoIdentityBackend` supplies bounded authenticated
transport. Set `origin` to the configured public application origin behind a proxy.
Every request rechecks identity, organization membership and allowed operations;
backend authorization remains mandatory. No browser administrator token is needed.
Unsupported operations stay hidden. Business organization data stays in the application.

For `profile`, `password`, `email` and `otp`, pass `hankoAccountAction(action)` to
your OIDC client's normal sign-in flow (Auth.js third argument). The host retains
state, nonce, PKCE and callback handling; Keycloak enforces editable fields and
federation restrictions. Wire `logout` to your application's normal sign-out.
The Theme Builder's `theme.runtime` supports live appearance updates through
`createHankoAppearanceProxy`, using a fixed public upstream and no session credentials.
Customize page titles and descriptions with `theme.modules["account.profile"]`
(and `account.organizations`, `account.access`, `account.security`); each accepts
`title` and `description` strings or `{ en, fr }` translations.

## Application authorization

For a backend without Passport, `createHankoAccessTokenVerifier({ issuer, audience })`
returns a verifier with bounded discovery, cached JWKS and the shared access-token
checks. After verifying the token, call `resolveHankoApplicationAccess(principal, audience)`
to resolve application roles and the active organization. A present organization
claim must select exactly one organization: ambiguous or malformed claims grant no
roles, and top-level roles from other organizations cannot fill the gap. Product
APIs keep checking ownership of their business resources; Hanko supplies IAM authority.

## IAM and backend clients

HankoShell owns identity and IAM policy across Alien6 products. Keycloak provides
SSO and the registered client's login theme; applications use their own client ID
and audience, with no theme or realm-policy override in the ADK.

`HankoIamClient` extends `HankoOrganizationClient` with directory reads, position
memberships, realm-role CRUD and direct user-role assignments. Both take the same
`{ apiUrl, accessToken }` options. The callback supplies the caller's current
short-lived token; Hanko authorizes each operation. The existing management API
still requires realm administration for its members and roles. Product backends
use `HankoDelegatedOrganizationClient` with a dedicated organization credential,
resolved through the same `accessToken` callback. Bind `realm`, `applicationId`
and `rootPositionId` at construction. It lists approved positions and changes
membership only for existing root members; the API verifies current group and
role boundaries before writes. Operator-owned structure and root admission remain
separate. Never distribute realm-admin credentials to application clients.

`createOrganizationDelegation`, `listOrganizationDelegations` and
`revokeOrganizationDelegation` on `HankoIamClient` manage these credentials.
Issuance requires an administrator session, an explicit role allowlist and an
expiry of 5 minutes to 24 hours. Keep the returned secret server-side; it cannot
call ordinary realm-administration endpoints. This requires the matching platform
API; it does not enable interactive active-node selection or agent delegation.

```ts
const iam = new HankoIamClient({
  apiUrl,
  accessToken: () => session.accessToken,
});
const positions = await iam.listPositions(realm);
const members = await iam.listMembers(realm, positionId);
```

`HankoTokenClient` supports server-side client credentials and explicit
RFC 8693 exchanges (`subjectToken`, `audience`, `scopes`, optional `actorToken`).
Pass a `clientSecret` callback in its options for rotating credentials. These are
protocol helpers: agent delegation additionally requires issuer trust, bounded
policy and end-to-end qualification of the Hanko facade and Keycloak extension.
The facade currently forwards exchange inputs unchanged; do not assume it can
exchange a Hanko re-signed subject token. Resource servers independently verify
every returned access token. Tokens and secrets are never persisted by the ADK.

## Refresh and logout

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

### Session ownership and rotation

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

### Auth.js integration contract

The [executable example](examples/authjs-session.ts) is type-checked by
`npm run test:examples` after building the package. Copy and adapt it to the
host; its comments identify the additional revocation/topology responsibilities.
It is not a ready-made distributed session service.

1. Capture the access token, refresh token, expiry and private logout hint in
   server-owned encrypted session state at sign-in. Use a renewal margin (for
   example 30 seconds) consistently in the browser/API and JWT callback.
2. Refresh through one owner on demand. Standalone browser
   `getSession({ broadcast: false })` returns JSON but does not update the same-tab
   `SessionProvider`. Use `useSession().update()` or an explicit common state owner
   so UI and API memory commit the same result. Polling is optional; lack of polling
   must not create a second unsynchronized refresh path.
3. Persist the rotated token **in the response actually sent to the browser**.
   Auth.js `/session` handlers and the `auth(handler)` request wrapper propagate
   replacement cookies. No-argument `auth()` returns parsed session JSON; a Server
   Component cannot write the refreshed cookie. Use a separate read-only callback
   configuration for render-time reads, as the example shows. Do not run consuming
   refresh callbacks from a path that discards `Set-Cookie`.
4. Whitelist public session fields. Never spread the JWT/account packet into
   session JSON or expose refresh tokens, client secrets, ID tokens or private
   logout hints. After refresh failure, preserve an explicit temporary/error or
   reauthentication state: do not silently send a protected request anonymously.
5. Test concurrent expiry, late old cookies, the next rotated refresh, response
   reordering, two tabs, logout during renewal and process replacement. Configure
   cookie origin/security and exact callback/logout URIs explicitly.

The application cookie lifetime, access-token lifetime and identity session
idle/maximum lifetimes are separate clocks. A valid application cookie does not
keep an idle identity session alive. Sign-in after a legitimately expired
identity session is expected; increasing a cookie lifetime cannot repair it.

`getHankoLogoutToken` retains Hanko's private upstream hint for server-side
sessions; `createHankoLogoutUrl` constructs RP-initiated logout. Never expose the
hint in a browser session or substitute a different ID token.

`HankoOrganizationClient` uses a supplied short-lived access-token callback.
Requests refuse redirects and default to five seconds and 1 MiB. `timeoutMs`
and `maxResponseBytes` can lower those limits or set a timeout up to 60 seconds.

## Develop and release

```sh
npm ci
npm run check
```

The package uses ESM and typed exports.

`/identity/react` and `/react` are React client entry points: bundle them with
your application's frontend. Node services use the root, `/authjs`, `/passport`,
`/identity` and `/identity/server` entry points.

Releases use `vX.Y.Z` tags matching
`package.json`; the release workflow publishes the tested npm archive and signed qualification evidence
on GitHub. The first npm publication uses that exact archive with maintainer 2FA.
For subsequent automated publication, configure the package's npm trusted publisher
for this repository and `release.yml`, then set `NPM_PUBLISH_ENABLED=true`.
No npm token is stored in this repository. Released versions are immutable.

The [Go ADK](https://github.com/Alien6-Studio/hankoshell-golang-adk) is maintained
separately. Both ADKs carry the same synthetic access-token vectors in `testdata/`.
The portable manifest is [integration v1](contracts/integration-v1.schema.json).
Applications retain their sessions and business authorization. Hanko's API owns
administration boundaries; the [operator](https://github.com/Alien6-Studio/hankoshell-operator)
reconciles declarative IAM configuration.

See [contribution](CONTRIBUTING.md) and [security reporting](SECURITY.md).

Copyright 2026 Alien6 Studio. Licensed under Apache-2.0.

## Attestation

The [Attestation workflow](https://github.com/Alien6-Studio/hankoshell-typescript-adk/actions/workflows/attest.yml)
runs the tests and builds a package without signing credentials. A separate job
recomputes the evidence against the reviewed commit, signs it with Continuum
Attest 0.2.0 and verifies signature, hashes and successful execution. Releases
publish that exact package. The public signer is pinned in [.github/attest/trust](.github/attest/trust).

To check a downloaded proof, check out its source revision and extract the
release's `qualification-evidence.tar.gz` at the repository root (or restore the
`signed-attestation` workflow artifact), then run:

```sh
attest verify proof/receipt.yaml --recompute --require signature,recompute,success --trust-store .github/attest/trust --offline
```

The receipt establishes the recorded checks and package identity. It does not
claim a hermetic build or an independently trusted timestamp.

`HankoApplicationOrganizationClient` manages product members and invitations with
the current user's access token. Hanko approves the application, organization
and client-role groups in its deployment policy. Invitation acceptance requires
the recipient's verified SSO email; applications keep their own routes and UI.
