# IAM and backend clients

Typed clients for the HankoShell API: organizations, memberships and invitations, IAM administration, delegated credentials, secret rotation and token exchange.

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

`HankoApplicationSecretClient` lets a product backend rotate the secret of its own
confidential applications from its dashboard. Bind `realm` and the `clientIds`
allowlist at construction; other applications are refused before any request.
`getApplication(clientId)` returns metadata without a secret, and
`rotateSecret(clientId)` returns `{ clientId, clientSecret, rotatedAt }` once. The
previous secret stops working. Show the new value to the operator once and store
it only where the connected client needs it; never log it. The platform API
currently requires realm administration for this route, so keep the credential on
the backend and limit who can reach the rotation action.

```ts
const secrets = new HankoApplicationSecretClient({
  apiUrl,
  accessToken: () => adminSession.accessToken,
  realm,
  clientIds: ["product-assistant"],
});
const { clientSecret, rotatedAt } = await secrets.rotateSecret("product-assistant");
```

`HankoTokenClient` supports server-side client credentials and explicit
RFC 8693 exchanges (`subjectToken`, `audience`, `scopes`, optional `actorToken`).
Pass a `clientSecret` callback in its options for rotating credentials. These are
protocol helpers: agent delegation additionally requires issuer trust, bounded
policy and end-to-end qualification of the Hanko facade and Keycloak extension.
The facade currently forwards exchange inputs unchanged; do not assume it can
exchange a Hanko re-signed subject token. Resource servers independently verify
every returned access token. Tokens and secrets are never persisted by the ADK.

## Application organization client

`HankoApplicationOrganizationClient` manages product members and invitations with
the current user's access token. Hanko approves the application, organization
and client-role groups in its deployment policy. Invitation acceptance requires
the recipient's verified SSO email; applications keep their own routes and UI.
