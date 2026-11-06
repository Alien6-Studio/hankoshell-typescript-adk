import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Auth } from "@auth/core";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import pg from "pg";
import { createHankoAuthJsSession } from "../dist/authjs-session.js";
import { createHankoPostgresSessionStore, HANKO_POSTGRES_SESSION_SCHEMA } from "../dist/sessions-postgres.js";

assert.ok(process.env.HANKO_TEST_DATABASE_URL, "Set HANKO_TEST_DATABASE_URL to a disposable empty PostgreSQL database");
const schema = "hanko_session_test_" + randomBytes(12).toString("hex");
const admin = new pg.Pool({ connectionString: process.env.HANKO_TEST_DATABASE_URL, max: 1 });
const poolA = new pg.Pool({ connectionString: process.env.HANKO_TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema},pg_catalog` });
const poolB = new pg.Pool({ connectionString: process.env.HANKO_TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema},pg_catalog` });
let issuer;
let refreshes = 0;
const codes = new Map();
const grants = new Set();
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "qualification", alg: "RS256", use: "sig" };
async function jwt(audience, claims, lifetime) {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setSubject("fixture-user").setAudience(audience).setIssuedAt().setExpirationTime(`${lifetime}s`).sign(privateKey);
}
async function packet(nonce, lifetime) {
  const refresh = randomBytes(32).toString("base64url");
  grants.add(refresh);
  return { access_token: await jwt("fixture-api", { hanko_token_use: "access", resource_access: { "fixture-api": { roles: ["member"] } } }, lifetime),
    id_token: await jwt("fixture-web", { nonce, name: "Fixture User", email: "fixture@example.test", email_verified: true }, lifetime),
    refresh_token: refresh, token_type: "Bearer", expires_in: lifetime };
}
const provider = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", userinfo_endpoint: issuer + "/userinfo", jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"] }));
    } else if (url.pathname === "/jwks") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("client_id"), "fixture-web");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(url.searchParams.get("state")); assert.ok(url.searchParams.get("nonce"));
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { challenge: url.searchParams.get("code_challenge"), nonce: url.searchParams.get("nonce"), redirect: url.searchParams.get("redirect_uri") });
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { Location: callback.toString() }); response.end();
    } else if (url.pathname === "/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const input = new URLSearchParams(body);
      assert.equal(input.get("client_id"), "fixture-web");
      assert.equal(input.get("client_secret"), "fixture-client-secret");
      let result;
      if (input.get("grant_type") === "authorization_code") {
        const code = input.get("code"); const value = codes.get(code); codes.delete(code); assert.ok(value);
        assert.equal(createHash("sha256").update(input.get("code_verifier")).digest("base64url"), value.challenge);
        assert.equal(input.get("redirect_uri"), value.redirect);
        result = await packet(value.nonce, 60);
      } else {
        assert.equal(input.get("grant_type"), "refresh_token");
        assert.ok(grants.delete(input.get("refresh_token")), "A single-use refresh grant was replayed");
        refreshes++;
        await new Promise(resolve => setTimeout(resolve, 60));
        result = await packet(undefined, 600);
      }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(400, { "Content-Type": "application/json" }); response.end('{"error":"invalid_request"}'); }
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
issuer = `http://127.0.0.1:${provider.address().port}`;
const origin = "http://127.0.0.1:31991";
const cookies = new Map();
const secret = randomBytes(32).toString("hex");
function integration(pool) {
  return createHankoAuthJsSession({ client: { issuer, clientId: "fixture-web", clientSecret: "fixture-client-secret" }, audience: "fixture-api", secret,
    store: createHankoPostgresSessionStore(pool), renewalMarginSeconds: 120 });
}
let a = integration(poolA);
let b = integration(poolB);
async function call(adapter, path, init = {}, cookieHeader) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookieHeader ?? [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
  const response = await Auth(new Request(origin + "/api/auth" + path, { ...init, headers }), { ...await adapter.config(), trustHost: true, basePath: "/api/auth",
    logger: { error(error) { console.error("Fixture authentication diagnostic:", error.type ?? error.name, error.cause?.err?.name ?? "", error.cause?.err?.stack?.split("\n").slice(1, 5).join("\n") ?? ""); }, warn() {}, debug() {} },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(";")[0]; const split = first.indexOf("=");
    cookies.set(first.slice(0, split), first.slice(split + 1));
  }
  return response;
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await poolA.query(HANKO_POSTGRES_SESSION_SCHEMA);
  const csrf = await (await call(a, "/csrf")).json();
  const login = await call(a, "/signin/hanko", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: origin + "/account" }) });
  assert.equal(login.status, 302);
  const authorization = await fetch(login.headers.get("Location"), { redirect: "manual" });
  const callback = new URL(authorization.headers.get("Location"));
  const result = await call(b, callback.pathname.slice("/api/auth".length) + callback.search);
  assert.equal(result.headers.get("Location"), origin + "/account", "OIDC callback did not establish a session");
  const oldCookies = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => call(index % 2 ? a : b, "/session", {}, oldCookies).then(response => response.json())));
  assert.equal(refreshes, 1);
  assert.ok(results.every(session => !session.error && session.sub === "fixture-user" && session.roles.includes("member")));
  assert.ok(results.every(session => !JSON.stringify(session).includes("refresh_token") && !JSON.stringify(session).includes("id_token")));
  const rows = await poolA.query("SELECT sealed FROM hanko_sessions");
  assert.equal(rows.rowCount, 1);
  for (const grant of grants) assert.ok(!rows.rows[0].sealed.includes(grant));
  a = integration(poolA); b = integration(poolB);
  assert.equal((await (await call(a, "/session", {}, oldCookies)).json()).sub, "fixture-user");
  const logoutCsrf = await (await call(a, "/csrf")).json();
  await call(b, "/signout", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: logoutCsrf.csrfToken }) });
  const late = await (await call(a, "/session", {}, oldCookies)).json();
  assert.equal(late.error, "ReauthenticationRequired");
  assert.equal((await poolB.query("SELECT id FROM hanko_sessions")).rowCount, 0);
  console.log("Qualified: real OIDC/PKCE/state/nonce, Auth.js cookies, PostgreSQL, two runtimes, one concurrent refresh, restart and logout revocation.");
} finally {
  await Promise.all([poolA.end(), poolB.end()]);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await new Promise(resolve => provider.close(resolve));
}
