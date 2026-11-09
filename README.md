# HankoShell TypeScript ADK

Add HankoShell sign-in, shared sessions and account screens to a Node.js or
React application in a few lines. You keep your framework, your routes and your
design system; the ADK handles the OIDC plumbing and talks to the HankoShell API.

[![npm](https://img.shields.io/npm/v/%40alien6-studio%2Fhankoshell-typescript-adk?logo=npm&label=npm)](https://www.npmjs.com/package/@alien6-studio/hankoshell-typescript-adk)
[![CI](https://github.com/Alien6-Studio/hankoshell-typescript-adk/actions/workflows/ci.yml/badge.svg)](https://github.com/Alien6-Studio/hankoshell-typescript-adk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## What you get

- **Auth.js integration** for Next.js: PKCE, encrypted server-side sessions in
  PostgreSQL, coordinated token renewal and sign-out revocation, in one call.
- **Passport strategy** for NestJS and Express APIs, plus a framework-free token
  verifier for everything else.
- **Application role checks** that never confuse realm roles with your app's roles.
- **Headless React account screens** (profile, organizations, access, security)
  rendered with your own components, in 8 languages.
- **Typed API clients** for organizations, memberships, invitations, IAM
  administration, secret rotation and token exchange.

Writing Go? The [Go ADK](https://github.com/Alien6-Studio/hankoshell-golang-adk)
ships the same contract under the same version.

## Install

Node 22 or 24.

```sh
npm install @alien6-studio/hankoshell-typescript-adk@0.7.2
```

Install the peer your entry point needs: `next-auth` and `pg` for Auth.js,
`passport-jwt` for Passport, `react` for the account screens.

## Configure

```text
HANKO_ISSUER=https://auth.example.test/realms/example
HANKO_CLIENT_ID=example-app
HANKO_CLIENT_SECRET=<server-only secret, when required>
HANKO_AUDIENCE=example-api
```

Load them with `loadHankoClientConfig(process.env)` (web apps) or
`loadHankoResourceServerConfig(process.env)` (APIs). Keep the client secret out
of browser bundles.

## Quick start

### Next.js with Auth.js

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

Mount the handlers at `/api/auth/[...nextauth]` on the Node runtime, apply
`HANKO_POSTGRES_SESSION_SCHEMA` with your migrations, and use an `AUTH_SECRET` of
at least 32 bytes shared by all replicas. Cookies only hold a random session
pointer; tokens stay encrypted on the server.
Read the [Auth.js guide](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/authjs.md)
before going to production.

### NestJS or Express API with Passport

```ts
import { Strategy } from "passport-jwt";
import { loadHankoResourceServerConfig, createHankoPrincipal, requireHankoApplicationAccess } from "@alien6-studio/hankoshell-typescript-adk";
import { createHankoJwtStrategyOptions } from "@alien6-studio/hankoshell-typescript-adk/passport";

const config = loadHankoResourceServerConfig(process.env);
const strategy = new Strategy(createHankoJwtStrategyOptions(config), (claims, done) => {
  try {
    done(null, createHankoPrincipal(claims, config.issuer, config.audience));
  } catch (error) {
    done(error);
  }
});

// In a guard, once Passport has verified the signature:
requireHankoApplicationAccess(principal, config.audience, ["staff", "admin"]); // throws HankoAccessError (403)
```

### Any other Node backend

```ts
import { createHankoAccessTokenVerifier, loadHankoResourceServerConfig, resolveHankoApplicationAccess } from "@alien6-studio/hankoshell-typescript-adk";

const config = loadHankoResourceServerConfig(process.env);
const verify = createHankoAccessTokenVerifier(config);
const principal = await verify(bearerToken);
const access = resolveHankoApplicationAccess(principal, config.audience);
```

### React account screens

```tsx
"use client";
import { HankoIdentityScreen } from "@alien6-studio/hankoshell-typescript-adk/identity/react";
import { createHankoIdentityClient } from "@alien6-studio/hankoshell-typescript-adk/identity";
import { hankoIdentityUI } from "./hanko-identity-ui"; // your buttons, fields, cards

const controller = createHankoIdentityClient({ endpoint: "/api/account" });
export function OrganizationPage({ subject }: { subject: string }) {
  return <HankoIdentityScreen subject={subject} controller={controller} page="organizations" ui={hankoIdentityUI} locale="fr" />;
}
```

The screens inject no CSS and no iframe. Bind your design system once through
the `ui` adapter ([shadcn/ui example](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/examples/shadcn-ui.tsx))
and expose `/api/account` with `createHankoIdentityHandler`. See the
[React screens guide](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/react-screens.md).

## Guides

| Guide | Read it when |
| --- | --- |
| [Auth.js sessions](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/authjs.md) | You deploy several replicas, implement logout, or wire the Auth.js callbacks yourself. |
| [Passport and authorization](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/authorization.md) | You protect an API and need application roles or organization context. |
| [React account screens](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/react-screens.md) | You build profile or organization pages, custom layouts, or multilingual UI. |
| [IAM and backend clients](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/clients.md) | Your backend manages members, invitations, roles, delegated credentials or secret rotation. |
| [Token refresh and rotation](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/refresh.md) | You handle refresh failures or run your own session owner. |
| [Develop, release and verify](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/guides/release.md) | You contribute, cut a release, or verify a signed release proof. |

Release notes live in [docs/releases](https://github.com/Alien6-Studio/hankoshell-typescript-adk/tree/main/docs/releases);
the Go and TypeScript ADKs share one version per qualified delivery, see the
[version policy](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/docs/versioning.md).

## Entry points

| Import | Use it for | Runs in |
| --- | --- | --- |
| `@alien6-studio/hankoshell-typescript-adk` | Config loading, token verification, principals, application access, API clients | Node |
| `…/authjs`, `…/authjs/session` | Auth.js provider and shared-session integration | Node |
| `…/sessions`, `…/sessions/postgres` | Session store contract and PostgreSQL implementation | Node |
| `…/passport` | `passport-jwt` strategy options | Node |
| `…/identity`, `…/identity/server` | Account controller client and same-origin server handler | Node |
| `…/identity/react`, `…/react` | Headless account screens and the themed wrapper | Browser |

The package is ESM with typed exports.

## Security defaults

- Browser sessions only see a short-lived access token, its expiry, the verified
  identity and role hints. Refresh tokens and logout hints never leave the server.
- Every API call is authorized again by HankoShell. Realm roles never stand in
  for application roles; ambiguous organization claims grant nothing.
- HTTP calls refuse redirects, time out after 5 seconds and cap bodies at 1 MiB.
- A refresh is never replayed after an ambiguous response. The failure category
  tells you whether a retry is safe.
- The ADK persists nothing except the session rows in the store you provide.

## Contributing

```sh
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for
security reports. Copyright 2026 Alien6 Studio. Licensed under Apache-2.0.
