import assert from "node:assert/strict";
import test from "node:test";
import { createExampleAuthConfig } from "./authjs-session.js";

const issuer = "https://auth.example.test/realms/example";
const environment = {
  HANKO_ISSUER: issuer, HANKO_CLIENT_ID: "example-app", HANKO_CLIENT_SECRET: "private-client-fixture",
  AUTH_SECRET: "independent-example-session-secret-at-least-thirty-two-characters",
};

test("the example executes a complete sign-in, single-use refresh and public-session whitelist", async (t) => {
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json({ issuer, token_endpoint: `${issuer}/token` });
    posts += 1;
    assert.equal(new URLSearchParams(String(init.body)).get("refresh_token"), "private-refresh-fixture");
    return posts === 1
      ? Response.json({ access_token: "new-access", refresh_token: "rotated-refresh-fixture", expires_in: 300 })
      : Response.json({ error: "invalid_grant" }, { status: 400 });
  });
  const config = createExampleAuthConfig(environment);
  const jwt = config.callbacks!.jwt! as (args: any) => Promise<any>;
  const session = config.callbacks!.session! as (args: any) => Promise<any>;
  const signedIn = await jwt({ token: { name: "Customer", email: "customer@example.test" }, account: {
    access_token: "initial-access", refresh_token: "private-refresh-fixture",
    expires_at: Math.floor(Date.now() / 1000) + 300, hanko_upstream_id_token: "private-logout-fixture",
  } });
  const expired = { ...signedIn, expiresAt: 1 };
  const [first, second] = await Promise.all([jwt({ token: expired }), jwt({ token: expired })]);
  assert.equal(posts, 1);
  assert.equal(first.refreshToken, "rotated-refresh-fixture");
  assert.equal(second.accessToken, first.accessToken);
  const publicSession = await session({ session: { expires: "2099-01-01", private_extra: "sentinel" }, token: first });
  assert.equal(publicSession.accessToken, "new-access");
  assert.doesNotMatch(JSON.stringify(publicSession), /private-|rotated-refresh|sentinel/);
  const readonlyConfig = createExampleAuthConfig(environment, false);
  const readJwt = readonlyConfig.callbacks!.jwt! as (args: any) => Promise<any>;
  assert.equal(await readJwt({ token: expired }), expired);
  assert.equal(posts, 1);
});

test("the example defers only pre-exchange failure and withholds all public access credentials", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => { reads += 1; return Response.json({}, { status: 503 }); });
  const config = createExampleAuthConfig({ ...environment, HANKO_CLIENT_ID: "example-deferred" });
  const jwt = config.callbacks!.jwt! as (args: any) => Promise<any>;
  const result = await jwt({ token: { accessToken: "expired", refreshToken: "private-deferred", expiresAt: 1 } });
  assert.equal(result.error, "AuthenticationTemporarilyUnavailable");
  assert.equal(result.accessToken, undefined);
  assert.equal(result.refreshToken, "private-deferred");
  assert.equal(result.refreshFailure.retryable, true);
  assert.equal(await jwt({ token: result }), result);
  assert.equal(reads, 1);
});
