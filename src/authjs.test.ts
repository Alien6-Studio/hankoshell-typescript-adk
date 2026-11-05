import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createHankoAuthJsProvider, createHankoRefreshCoordinator, refreshHankoAccessToken } from "./authjs.js";
import type { HankoFetch } from "./discovery.js";
import { HankoDiscovery } from "./discovery.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const config = {
  issuer: "https://auth.example.test/realms/demo",
  clientId: "example-dashboard",
  clientSecret: "secret",
};

test("creates the mandatory Auth.js OIDC provider checks", () => {
  const provider = createHankoAuthJsProvider({ ...config, issuer: `${config.issuer}/` });
  assert.equal(provider.id, "hanko");
  assert.deepEqual(provider.checks, ["pkce", "state", "nonce"]);
  assert.equal(provider.options?.issuer, config.issuer);
  assert.equal(provider.options?.clientId, config.clientId);
});

test("preserves security after Auth.js normalizes the actual provider", async () => {
  const require = createRequire(import.meta.url);
  const parser = pathToFileURL(join(dirname(require.resolve("@auth/core")), "lib/utils/providers.js")).href;
  const { default: parseProviders } = await import(parser);
  const provider = createHankoAuthJsProvider(config, { name: "Example login" });
  const { providers } = parseProviders({ url: new URL("https://app.example.test/auth"), config: { providers: [provider] } });
  assert.deepEqual(providers[0].checks, ["pkce", "state", "nonce"]);
  assert.equal(providers[0].issuer, config.issuer);
  for (const value of [{ checks: ["none", "none", "none"] }, { token: "https://other.example.test/token" },
    { authorization: "https://other.example.test/login" }, { wellKnown: "https://other.example.test" }]) {
    assert.throws(() => createHankoAuthJsProvider(config, value as Parameters<typeof createHankoAuthJsProvider>[1]), /Unsupported/);
  }
});

test("refreshes a token through discovered Hanko metadata", async () => {
  const requests: string[] = [];
  const fetcher: HankoFetch = async (input, init) => {
    const url = input.toString();
    requests.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return jsonResponse({
        issuer: "https://auth.example.test/realms/demo",
        token_endpoint: "https://auth.example.test/realms/demo/token",
      });
    }
    assert.equal(init?.method, "POST");
    assert.match(String(init?.body), /grant_type=refresh_token/);
    return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 300, hanko_upstream_id_token: "new-logout-hint" });
  };

  const refreshed = await refreshHankoAccessToken(
    { accessToken: "old", refreshToken: "refresh", expiresAt: 1 },
    config,
    { fetch: fetcher, now: () => 1_000_000 },
  );

  assert.equal(refreshed.accessToken, "new-access");
  assert.equal(refreshed.refreshToken, "new-refresh");
  assert.equal(refreshed.expiresAt, 1300);
  assert.equal(refreshed.error, undefined);
  assert.equal(refreshed.logoutToken, "new-logout-hint");
  assert.equal(requests.length, 2);
});

test("fails closed when refresh is unavailable", async () => {
  const refreshed = await refreshHankoAccessToken({ accessToken: "old" }, config);
  assert.equal(refreshed.error, "HankoRefreshTokenError");
  assert.equal(refreshed.accessToken, "old");
  assert.deepEqual(refreshed.refreshFailure, { category: "missing_refresh_token", stage: "configuration", retryable: false });
});

function provider(tokenResponse: () => Promise<Response>): HankoFetch {
  return async (input) => input.toString().endsWith("/.well-known/openid-configuration")
    ? jsonResponse({ issuer: config.issuer, token_endpoint: `${config.issuer}/token` })
    : tokenResponse();
}

test("classifies only safe discovery failures as retryable, without exposing provider packets", async () => {
  let posts = 0;
  const token = { accessToken: "old-secret", refreshToken: "refresh-secret" };
  for (const fetcher of [
    async () => jsonResponse({ secret: "private-provider-sentinel" }, 503),
    async () => { throw new Error("private-network-sentinel"); },
  ]) {
    const result = await refreshHankoAccessToken(token, config, { fetch: async (input, init) => {
      if (init?.method === "POST") posts += 1;
      return fetcher();
    } });
    assert.equal(result.refreshFailure?.category, "discovery_unavailable");
    assert.equal(result.refreshFailure?.retryable, true);
    assert.doesNotMatch(JSON.stringify(result.refreshFailure), /sentinel|secret/);
  }
  const substituted = await refreshHankoAccessToken(token, config, { fetch: async () => jsonResponse({ issuer: "https://outside.example.test" }) });
  assert.equal(substituted.refreshFailure?.category, "discovery_invalid");
  assert.equal(substituted.refreshFailure?.retryable, false);
  assert.equal(posts, 0);
});

test("distinguishes rejected grants, client errors and provider failures without retrying a POST", async () => {
  const token = { refreshToken: "refresh-secret" };
  for (const [status, error, category] of [
    [400, "invalid_grant", "rejected_grant"], [401, "invalid_client", "client_configuration"],
    [503, "temporarily_unavailable", "provider_unavailable"], [429, "rate_limited", "provider_unavailable"],
    [400, "private-provider-sentinel", "refresh_outcome_unknown"],
  ] as const) {
    let posts = 0;
    const result = await refreshHankoAccessToken(token, config, { fetch: provider(async () => {
      posts += 1;
      return jsonResponse({ error, error_description: "private-provider-sentinel" }, status);
    }), errorCode: "ApplicationRefreshError" });
    assert.equal(posts, 1);
    assert.equal(result.error, "ApplicationRefreshError");
    assert.equal(result.refreshFailure?.category, category);
    assert.equal(result.refreshFailure?.retryable, false);
    assert.equal(result.refreshFailure?.httpStatus, status);
    assert.doesNotMatch(JSON.stringify(result.refreshFailure), /sentinel|description/);
  }
});

test("treats lost POST outcomes and invalid success packets as unsafe to replay", async () => {
  for (const response of [
    async () => { throw new Error("private-network-sentinel"); },
    async () => new Response("private-packet-sentinel"),
    async () => jsonResponse({ access_token: "", expires_in: 300 }),
    async () => jsonResponse({ access_token: "new", expires_in: 0.5 }),
    async () => jsonResponse({ access_token: "new", expires_in: Number.MAX_SAFE_INTEGER }),
  ]) {
    const result = await refreshHankoAccessToken({ refreshToken: "refresh-secret" }, config, { fetch: provider(response) });
    assert.ok(["refresh_outcome_unknown", "invalid_response"].includes(result.refreshFailure!.category));
    assert.equal(result.refreshFailure?.retryable, false);
    assert.doesNotMatch(JSON.stringify(result.refreshFailure), /sentinel/);
  }
  const timeout = await refreshHankoAccessToken({ refreshToken: "refresh-secret" }, config, {
    fetch: provider(() => new Promise<Response>(() => undefined)), timeoutMs: 10,
  });
  assert.equal(timeout.refreshFailure?.category, "refresh_outcome_unknown");
  assert.equal(timeout.refreshFailure?.retryable, false);
});

test("coalesces a single-use rotation, reuses late old-cookie results and keeps caller fields isolated", async () => {
  const coordinator = createHankoRefreshCoordinator();
  const used = new Set<string>();
  let posts = 0;
  const fetcher: HankoFetch = async (input, init) => {
    if (input.toString().endsWith("/.well-known/openid-configuration")) return jsonResponse({ issuer: config.issuer, token_endpoint: `${config.issuer}/token` });
    posts += 1;
    const refresh = new URLSearchParams(String(init?.body)).get("refresh_token")!;
    if (used.has(refresh)) return jsonResponse({ error: "invalid_grant" }, 400);
    used.add(refresh);
    return jsonResponse({ access_token: `access-${posts}`, refresh_token: `refresh-${posts}`, expires_in: 300 });
  };
  const original = { refreshToken: "initial-single-use", accessToken: "old", expiresAt: 1 };
  const [first, second] = await Promise.all([
    coordinator.refresh({ ...original, name: "First caller", sub: "subject", logoutToken: "first-private-hint" }, config, { fetch: fetcher }),
    coordinator.refresh({ ...original, name: "Second caller", sub: "subject", logoutToken: "second-private-hint" }, config, { fetch: fetcher }),
  ]);
  assert.equal(posts, 1);
  assert.equal(first.name, "First caller");
  assert.equal(second.name, "Second caller");
  assert.equal(first.logoutToken, "first-private-hint");
  assert.equal(second.logoutToken, "second-private-hint");
  assert.equal(first.refreshToken, "refresh-1");
  assert.equal(second.refreshToken, first.refreshToken);
  assert.equal((await coordinator.refresh(original, config, { fetch: fetcher })).accessToken, "access-1");
  assert.equal(posts, 1);
  const next = await coordinator.refresh(first, config, { fetch: fetcher });
  assert.equal(next.accessToken, "access-2");
  assert.equal(next.refreshToken, "refresh-2");
  assert.equal(next.logoutToken, "first-private-hint");
  assert.equal(posts, 2);
});

test("keeps different issuers, clients and credentials out of the same rotation lineage", async () => {
  const coordinator = createHankoRefreshCoordinator();
  let posts = 0;
  for (const client of [config, { ...config, clientId: "other" }, { ...config, clientSecret: "rotated" }, { ...config, issuer: "https://other.example.test/realms/demo" }]) {
    const result = await coordinator.refresh({ refreshToken: "same-value" }, client, { fetch: async (_input, init) => {
      if (init?.method !== "POST") return jsonResponse({ issuer: client.issuer, token_endpoint: `${client.issuer}/token` });
      posts += 1;
      return jsonResponse({ access_token: `access-${posts}`, expires_in: 300 });
    } });
    assert.equal(result.accessToken, `access-${posts}`);
  }
  assert.equal(posts, 4);
});

test("retains failed outcomes briefly and applies each caller's error code", async () => {
  let time = 1_000_000;
  let posts = 0;
  const coordinator = createHankoRefreshCoordinator({ now: () => time, reuseWindowMs: 100 });
  const fetcher = provider(async () => { posts += 1; throw new Error("lost-response"); });
  const token = { refreshToken: "single-use" };
  const first = await coordinator.refresh(token, config, { fetch: fetcher });
  const late = await coordinator.refresh(token, config, { fetch: fetcher, errorCode: "CustomError" });
  assert.equal(first.refreshFailure?.category, "refresh_outcome_unknown");
  assert.equal(late.error, "CustomError");
  assert.equal(posts, 1);
  time += 101;
  await coordinator.refresh({ refreshToken: "separate-lineage" }, config, { fetch: fetcher });
  assert.equal(posts, 2);
});

test("fails safely at capacity without evicting pending exchanges or replaying their token", async () => {
  let release: (response: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  const fetcher = provider(async () => { posts += 1; started(); return pending; });
  const coordinator = createHankoRefreshCoordinator({ maxEntries: 1 });
  const token = { refreshToken: "pending" };
  const first = coordinator.refresh(token, config, { fetch: fetcher });
  await startedPromise;
  const capacity = await coordinator.refresh({ refreshToken: "other" }, config, { fetch: fetcher });
  const shared = coordinator.refresh(token, config, { fetch: fetcher });
  assert.equal(capacity.refreshFailure?.category, "coordinator_capacity");
  assert.equal(capacity.refreshFailure?.retryable, true);
  release(jsonResponse({ access_token: "renewed", expires_in: 300 }));
  const results = await Promise.all([first, shared]);
  assert.equal(posts, 1);
  assert.equal(results[0].accessToken, results[1].accessToken);
});

test("invalidation fences pending results and prevents immediate old-cookie replay", async () => {
  let release: (response: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  const fetcher = provider(async () => { posts += 1; started(); return pending; });
  const coordinator = createHankoRefreshCoordinator();
  const token = { refreshToken: "pending" };
  const result = coordinator.refresh(token, config, { fetch: fetcher });
  await startedPromise;
  assert.equal(await coordinator.invalidate(token, config), true);
  release(jsonResponse({ access_token: "must-not-be-restored", expires_in: 300 }));
  assert.equal((await result).refreshFailure?.category, "session_invalidated");
  assert.equal((await coordinator.refresh(token, config, { fetch: fetcher })).refreshFailure?.category, "session_invalidated");
  assert.equal(posts, 1);
});

test("clear fences work hashing concurrently and invalidates completed results", async () => {
  const coordinator = createHankoRefreshCoordinator();
  let posts = 0;
  const fetcher = provider(async () => { posts += 1; return jsonResponse({ access_token: "new", expires_in: 300 }); });
  const token = { refreshToken: "original" };
  await coordinator.refresh(token, config, { fetch: fetcher });
  const hashing = coordinator.refresh({ refreshToken: "still-hashing" }, config, { fetch: fetcher });
  coordinator.clear();
  assert.equal((await hashing).refreshFailure?.category, "session_invalidated");
  assert.equal((await coordinator.refresh(token, config, { fetch: fetcher })).refreshFailure?.category, "session_invalidated");
  assert.equal(posts, 1);
});

test("snapshots token and client before hashing so mutation cannot poison another lineage", async () => {
  const coordinator = createHankoRefreshCoordinator();
  const token = { refreshToken: "original", name: "Original caller", logoutToken: "original-hint" };
  const client = { ...config };
  let posts = 0;
  const fetcher: HankoFetch = async (input, init) => {
    assert.ok(String(input).startsWith(config.issuer));
    if (init?.method !== "POST") return jsonResponse({ issuer: config.issuer, token_endpoint: `${config.issuer}/token` });
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get("refresh_token"), "original");
    assert.equal(body.get("client_id"), config.clientId);
    assert.equal(body.get("client_secret"), config.clientSecret);
    posts += 1;
    return jsonResponse({ access_token: "original-lineage-access", expires_in: 300 });
  };
  const pending = coordinator.refresh(token, client, { fetch: fetcher });
  token.refreshToken = "mutated";
  token.name = "Changed later";
  token.logoutToken = "changed-hint";
  client.issuer = "https://outside.example.test";
  client.clientId = "mutated";
  client.clientSecret = "changed-secret";
  const result = await pending;
  assert.equal(result.name, "Original caller");
  assert.equal(result.logoutToken, "original-hint");
  assert.equal(result.accessToken, "original-lineage-access");
  const cached = await coordinator.refresh({ refreshToken: "original" }, config, { fetch: fetcher });
  assert.equal(cached.accessToken, "original-lineage-access");
  assert.equal(posts, 1);
  const invalidated = coordinator.invalidate({ refreshToken: "original" }, config);
  assert.equal(await invalidated, true);
  assert.equal((await coordinator.refresh({ refreshToken: "original" }, config, { fetch: fetcher })).refreshFailure?.category, "session_invalidated");
});

test("rejects an injected discovery instance for another issuer before exposing client credentials", async () => {
  let posts = 0;
  const discovery = new HankoDiscovery("https://outside.example.test", { fetch: async () => jsonResponse({ issuer: "https://outside.example.test", token_endpoint: "https://outside.example.test/token" }) });
  const result = await refreshHankoAccessToken({ refreshToken: "private-refresh" }, config, {
    discovery, fetch: async () => { posts += 1; return jsonResponse({ access_token: "wrong", expires_in: 300 }); },
  });
  assert.equal(posts, 0);
  assert.equal(result.refreshFailure?.category, "discovery_invalid");
  assert.equal(result.refreshFailure?.retryable, false);
});
