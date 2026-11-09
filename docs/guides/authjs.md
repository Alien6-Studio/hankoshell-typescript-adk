# Auth.js sessions

Complete guide to the Auth.js integration: shared PostgreSQL sessions, cookies, logout, qualification and the integration contract the host must respect. Start with the [README quick start](../../README.md#nextjs-with-authjs).

## Shared session integration

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
own their session lifecycle. Its smaller [cookie-session example](../../examples/authjs-session.ts)
uses process-local coordination and does not provide shared storage or distributed
revocation. Do not use it as the multi-replica reference.

Run `HANKO_TEST_DATABASE_URL=<empty disposable database> npm run test:session-flow`
to qualify real OIDC/PKCE, Auth.js cookies, PostgreSQL, concurrent independent
instances, restart and logout with synthetic identities. See the
[0.7.0 milestone](../releases/0.7.0.md).

## Integration contract

The [executable example](../../examples/authjs-session.ts) is type-checked by
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
