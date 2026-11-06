import assert from "node:assert/strict";
import { test } from "node:test";
import { createHankoSessionManager, HankoSessionError, type HankoSessionStore, type HankoStoredSession, type HankoSessionTokens } from "./sessions.js";
import { createHankoAuthJsSession } from "./authjs-session.js";

class SharedStore implements HankoSessionStore {
  rows = new Map<string, HankoStoredSession>();
  async create(scope: string, value: HankoStoredSession) { const key = scope + value.id; if (this.rows.has(key)) return false; this.rows.set(key, { ...value }); return true; }
  async read(scope: string, id: string) { const value = this.rows.get(scope + id); return value ? { ...value } : null; }
  async replace(scope: string, previous: string, value: HankoStoredSession) { const key = scope + value.id; if (this.rows.get(key)?.revision !== previous) return false; this.rows.set(key, { ...value }); return true; }
  async remove(scope: string, id: string) { this.rows.delete(scope + id); }
}
const client = { issuer: "https://auth.example.test/realms/example", clientId: "web" };
const initial = { accessToken: "access-private", refreshToken: "refresh-private", logoutToken: "logout-private", expiresAt: 2000 };
function fixture(extra: Partial<Parameters<typeof createHankoSessionManager>[0]> = {}) {
  const store = new SharedStore();
  let clock = 1000_000;
  let exchanges = 0;
  const options = { client, audience: "api", secret: "s".repeat(32), store,
    now: () => clock,
    verify: async (_token: string) => ({ issuer: client.issuer, subject: "alice", audiences: ["api"], claims: { resource_access: { api: { roles: ["member"] } } } }),
    refresh: async (tokens: HankoSessionTokens) => { exchanges++; await new Promise(resolve => setTimeout(resolve, 15)); return { ...tokens, accessToken: "renewed-private", refreshToken: "rotated-private", expiresAt: 3000 }; },
    ...extra };
  return { options, store, get exchanges() { return exchanges; }, setClock(value: number) { clock = value; } };
}
test("independent runtimes share one renewal, survive restart and keep credentials encrypted", async () => {
  const f = fixture();
  const a = createHankoSessionManager(f.options);
  const session = await a.create(initial);
  const stored = JSON.stringify([...f.store.rows.values()]);
  for (const credential of Object.values(initial).filter(value => typeof value === "string")) assert.ok(!stored.includes(credential));
  f.setClock(1990_000);
  const b = createHankoSessionManager(f.options);
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? a : b).read(session.id)));
  assert.equal(f.exchanges, 1);
  assert.ok(results.every(result => result.tokens.refreshToken === "rotated-private"));
  const restarted = createHankoSessionManager(f.options);
  assert.equal((await restarted.read(session.id)).tokens.accessToken, "renewed-private");
  await restarted.revoke(session.id);
  await assert.rejects(a.read(session.id), { category: "session_expired" });
});
test("logout fences late renewal without restoring the session", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const exchange = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ refresh: async tokens => { started(); await pending; return { ...tokens, expiresAt: 3000 }; } });
  const manager = createHankoSessionManager(f.options);
  const session = await manager.create(initial);
  f.setClock(1990_000);
  const refresh = manager.read(session.id);
  await exchange;
  await createHankoSessionManager(f.options).revoke(session.id);
  release();
  await assert.rejects(refresh, { category: "session_expired" });
  assert.equal(f.store.rows.size, 0);
});
test("unknown, rejected and invalid refreshes are terminal and never replayed", async () => {
  for (const refresh of [async () => { throw new Error("raw-provider-secret"); }, async () => ({ ...initial, error: "denied" }), async () => ({ ...initial, expiresAt: 0 })]) {
    let calls = 0;
    const f = fixture({ refresh: async () => { calls++; return refresh(); } });
    const manager = createHankoSessionManager(f.options);
    const session = await manager.create(initial);
    f.setClock(1990_000);
    const results = await Promise.allSettled([manager.read(session.id), createHankoSessionManager(f.options).read(session.id)]);
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.status === "rejected" && result.reason instanceof HankoSessionError && !result.reason.message.includes("raw-provider-secret")));
    await assert.rejects(manager.read(session.id));
    assert.equal(calls, 1);
  }
});
test("only explicitly pre-exchange failures release the lease for later recovery", async () => {
  let calls = 0;
  const f = fixture({ refresh: async tokens => (++calls === 1 ? { ...tokens, error: "deferred", refreshFailure: { retryable: true } } : { ...tokens, expiresAt: 3000 }) });
  const manager = createHankoSessionManager(f.options);
  const session = await manager.create(initial);
  f.setClock(1990_000);
  await assert.rejects(manager.read(session.id), { category: "session_unavailable" });
  assert.equal((await manager.read(session.id)).tokens.expiresAt, 3000);
});
test("a crashed refresh owner is never replaced by a second token exchange", async () => {
  const f = fixture({ waitMs: 1 });
  const manager = createHankoSessionManager(f.options);
  const session = await manager.create(initial);
  const [key, row] = [...f.store.rows.entries()][0]!;
  f.store.rows.set(key, { ...row, leaseUntil: 1000_100 });
  await assert.rejects(manager.read(session.id), { category: "session_unavailable" });
  f.setClock(1000_101);
  await assert.rejects(manager.read(session.id), { category: "refresh_outcome_unknown" });
  assert.equal(f.exchanges, 0);
});
test("wrong key, client, audience, subject and ciphertext cannot cross session boundaries", async () => {
  const f = fixture();
  const manager = createHankoSessionManager(f.options);
  const session = await manager.create(initial);
  for (const changes of [{ secret: "x".repeat(32) }, { client: { ...client, clientId: "other" } }, { audience: "other" }, { verify: async () => ({ issuer: client.issuer, subject: "bob", audiences: ["api"], claims: {} }) }]) {
    await assert.rejects(createHankoSessionManager({ ...f.options, ...changes }).read(session.id));
  }
  const [key, row] = [...f.store.rows.entries()][0]!;
  f.store.rows.set(key, { ...row, sealed: row.sealed.slice(0, -8) + "tampered" });
  await assert.rejects(manager.read(session.id), { category: "session_unavailable" });
});
test("invalid setup, expired state and storage failure return safe bounded outcomes", async () => {
  const f = fixture();
  for (const changes of [{ secret: "short" }, { audience: "" }, { maxAgeSeconds: 0 }, { leaseMs: 0 }, { waitMs: 0 }, { renewalMarginSeconds: -1 }]) assert.throws(() => createHankoSessionManager({ ...f.options, ...changes }));
  const manager = createHankoSessionManager(f.options);
  await assert.rejects(manager.read("bad"), { category: "session_expired" });
  await assert.rejects(manager.create({ ...initial, expiresAt: 0 }), { category: "invalid_token" });
  const session = await manager.create(initial);
  f.setClock(40_000_000);
  await assert.rejects(manager.read(session.id), { category: "session_expired" });
  f.store.read = async () => { throw new Error("database-password"); };
  await assert.rejects(manager.read(session.id), { category: "session_unavailable", message: "Hanko session failed (session_unavailable)" });
});
test("Auth.js config keeps the opaque pointer in cookies and exposes no long-lived credentials", async () => {
  const f = fixture();
  const adapter = createHankoAuthJsSession(f.options);
  const config = await adapter.config();
  const token = await adapter.callbacks.jwt({ token: {}, account: { provider: "hanko", type: "oidc", providerAccountId: "alice", access_token: initial.accessToken, refresh_token: initial.refreshToken!, id_token: "id-token-private", expires_at: initial.expiresAt }, profile: { sub: "alice" }, user: { id: "alice" }, trigger: "signIn" });
  assert.deepEqual(Object.keys(token), ["hankoSessionId"]);
  const session = await adapter.callbacks.session({ session: { expires: "irrelevant" }, token });
  assert.equal(session.accessToken, initial.accessToken);
  assert.ok(!JSON.stringify(session).includes(initial.refreshToken));
  assert.ok(!JSON.stringify(session).includes("id-token-private"));
  assert.equal(await adapter.logoutToken({}), undefined);
  await adapter.revoke(token);
  assert.equal((await adapter.callbacks.session({ session: { expires: "irrelevant" }, token })).error, "ReauthenticationRequired");
  assert.equal(config.session?.strategy, "jwt");
});
