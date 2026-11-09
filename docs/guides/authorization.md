# Passport and application authorization

Verify HankoShell access tokens in a NestJS, Express or plain Node backend, then require application roles. Realm roles never substitute application roles.

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

## Backends without Passport

For a backend without Passport, `createHankoAccessTokenVerifier({ issuer, audience })`
returns a verifier with bounded discovery, cached JWKS and the shared access-token
checks. After verifying the token, call `resolveHankoApplicationAccess(principal, audience)`
to resolve application roles and the active organization. A present organization
claim must select exactly one organization: ambiguous or malformed claims grant no
roles, and top-level roles from other organizations cannot fill the gap. Product
APIs keep checking ownership of their business resources; Hanko supplies IAM authority.
