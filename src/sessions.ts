import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { normalizeHankoClientConfig, type HankoClientConfig } from "./config.js";
import { createHankoAccessTokenVerifier } from "./verify.js";
import type { HankoPrincipal } from "./principal.js";
import { HankoHttpError, HankoTransportError, HankoResponseError } from "./http.js";
import { HankoDiscoveryError } from "./discovery.js";
import type { HankoRefreshFailure } from "./authjs.js";

/** Opaque encrypted state. Store implementations must make each operation atomic. */
export interface HankoStoredSession {
  readonly id: string;
  readonly revision: string;
  readonly expiresAt: number;
  readonly sealed: string;
  readonly leaseUntil: number;
}
export interface HankoSessionStore {
  create(scope: string, value: HankoStoredSession): Promise<boolean>;
  read(scope: string, id: string): Promise<HankoStoredSession | null>;
  /** Replace only the exact revision; never insert a missing/revoked session. */
  replace(scope: string, previousRevision: string, value: HankoStoredSession): Promise<boolean>;
  remove(scope: string, id: string): Promise<void>;
}
export interface HankoSessionTokens {
  accessToken: string;
  refreshToken?: string | undefined;
  logoutToken?: string | undefined;
  /** Unix seconds, as returned by OAuth providers. */
  expiresAt: number;
}
export type HankoSessionFailure = "session_expired" | "session_unavailable" | "refresh_rejected" | "refresh_outcome_unknown" | "invalid_token";
export class HankoSessionError extends Error {
  readonly refreshFailure?: HankoRefreshFailure;
  constructor(readonly category: HankoSessionFailure, failure?: HankoRefreshFailure) {
    super(`Hanko session failed (${category})`);
    const categories = ["missing_refresh_token", "configuration", "discovery_unavailable", "discovery_invalid", "rejected_grant", "client_configuration", "provider_unavailable", "refresh_outcome_unknown", "invalid_response", "coordinator_capacity", "session_invalidated"];
    if (failure) this.refreshFailure = { category: categories.includes(failure.category) ? failure.category : "refresh_outcome_unknown",
      stage: ["configuration", "discovery", "refresh", "coordination"].includes(failure.stage) ? failure.stage : "refresh",
      retryable: failure.retryable === true && ((failure.category === "discovery_unavailable" && failure.stage === "discovery") || (failure.category === "coordinator_capacity" && failure.stage === "coordination")),
      ...(Number.isSafeInteger(failure.httpStatus) && Number(failure.httpStatus) >= 100 && Number(failure.httpStatus) <= 599 ? { httpStatus: failure.httpStatus! } : {}) };
  }
}
export interface HankoSession {
  readonly id: string;
  readonly expiresAt: number;
  readonly tokens: HankoSessionTokens;
  readonly principal: HankoPrincipal;
}
export interface HankoSessionManagerOptions {
  readonly client: HankoClientConfig;
  readonly audience: string;
  readonly secret: string;
  readonly store: HankoSessionStore;
  readonly refresh: (tokens: HankoSessionTokens) => Promise<HankoSessionTokens & { error?: string | undefined; refreshFailure?: HankoRefreshFailure | undefined }>;
  readonly verify?: (token: string) => Promise<HankoPrincipal>;
  readonly maxAgeSeconds?: number;
  readonly renewalMarginSeconds?: number;
  readonly leaseMs?: number;
  readonly waitMs?: number;
  readonly now?: () => number;
}
interface Envelope { tokens: HankoSessionTokens; subject: string }
const identifier = /^[A-Za-z0-9_-]{43}$/u;

/** Server-only authoritative sessions. Browser cookies retain only the random id. */
export function createHankoSessionManager(options: HankoSessionManagerOptions) {
  const client = normalizeHankoClientConfig(options.client);
  if (!options.audience.trim() || Buffer.byteLength(options.secret) < 32) throw new Error("Hanko sessions require an audience and a secret of at least 32 bytes");
  const maxAge = options.maxAgeSeconds ?? 8 * 3600;
  const margin = options.renewalMarginSeconds ?? 30;
  const leaseMs = options.leaseMs ?? 30_000;
  const waitMs = options.waitMs ?? 5_000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 30 * 86400 ||
      !Number.isSafeInteger(margin) || margin < 0 || margin > 300 ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120_000 ||
      !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 30_000) throw new Error("Invalid Hanko session limits");
  const scope = createHash("sha256").update(JSON.stringify([client.issuer, client.clientId, options.audience])).digest("hex");
  const key = Buffer.from(hkdfSync("sha256", options.secret, scope, "hanko-session-v1", 32));
  const now = options.now ?? Date.now;
  const verify = options.verify ?? createHankoAccessTokenVerifier({ issuer: client.issuer, audience: options.audience });
  function seal(id: string, value: Envelope): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${scope}:${id}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  function open(value: HankoStoredSession): Envelope {
    try {
      const data = Buffer.from(value.sealed, "base64url");
      if (data.length > 256_000) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(`${scope}:${value.id}`));
      cipher.setAuthTag(data.subarray(12, 28));
      const envelope: Envelope = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
      if (!envelope.subject || !validTokens(envelope.tokens)) throw new Error();
      return envelope;
    } catch { throw new HankoSessionError("session_unavailable"); }
  }
  function validTokens(tokens: HankoSessionTokens): boolean {
    return !!tokens && typeof tokens.accessToken === "string" && tokens.accessToken.length > 0 && tokens.accessToken.length <= 128_000 &&
      Number.isSafeInteger(tokens.expiresAt) && tokens.expiresAt > 0 &&
      (tokens.refreshToken === undefined || (typeof tokens.refreshToken === "string" && tokens.refreshToken.length <= 128_000)) &&
      (tokens.logoutToken === undefined || (typeof tokens.logoutToken === "string" && tokens.logoutToken.length <= 128_000));
  }
  async function verified(tokens: HankoSessionTokens, subject?: string): Promise<HankoPrincipal> {
    if (!validTokens(tokens) || tokens.expiresAt * 1000 <= now()) throw new HankoSessionError("invalid_token");
    try {
      const principal = await verify(tokens.accessToken);
      if (principal.issuer !== client.issuer || !principal.subject || !principal.audiences.includes(options.audience) || (subject !== undefined && principal.subject !== subject)) throw new Error();
      return principal;
    } catch (error) {
      if (error instanceof HankoHttpError || error instanceof HankoTransportError || error instanceof HankoResponseError || error instanceof HankoDiscoveryError) throw new HankoSessionError("session_unavailable");
      throw new HankoSessionError("invalid_token");
    }
  }
  async function stored<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch { throw new HankoSessionError("session_unavailable"); }
  }
  async function revoke(id: string): Promise<void> {
    if (identifier.test(id)) await stored(() => options.store.remove(scope, id));
  }
  return {
    async create(tokens: HankoSessionTokens): Promise<HankoSession> {
      tokens = { ...tokens };
      const principal = await verified(tokens);
      const id = randomBytes(32).toString("base64url");
      const expiresAt = now() + maxAge * 1000;
      const value = { id, revision: randomUUID(), expiresAt, leaseUntil: 0, sealed: seal(id, { tokens, subject: principal.subject }) };
      if (!await stored(() => options.store.create(scope, value))) throw new HankoSessionError("session_unavailable");
      return { id, expiresAt, tokens, principal };
    },
    async read(id: string): Promise<HankoSession> {
      if (!identifier.test(id)) throw new HankoSessionError("session_expired");
      // A real deadline keeps a test clock or a backwards wall-clock jump from hanging requests.
      const deadline = performance.now() + waitMs;
      while (true) {
        if (performance.now() >= deadline) throw new HankoSessionError("session_unavailable");
        const value = await stored(() => options.store.read(scope, id));
        if (!value || value.expiresAt <= now()) { await revoke(id); throw new HankoSessionError("session_expired"); }
        const envelope = open(value);
        if (value.leaseUntil !== 0) {
          // A crashed owner might have consumed the grant. Never take over its exchange.
          if (value.leaseUntil <= now()) { await revoke(id); throw new HankoSessionError("refresh_outcome_unknown"); }
          if (performance.now() >= deadline) throw new HankoSessionError("session_unavailable");
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        if (envelope.tokens.expiresAt * 1000 > now() + margin * 1000) {
          return { id, expiresAt: value.expiresAt, tokens: envelope.tokens, principal: await verified(envelope.tokens, envelope.subject) };
        }
        const claimed = { ...value, revision: randomUUID(), leaseUntil: now() + leaseMs };
        if (!await stored(() => options.store.replace(scope, value.revision, claimed))) continue;
        let tokens: HankoSessionTokens;
        let principal: HankoPrincipal;
        try {
          const result = await options.refresh({ ...envelope.tokens });
          if (result.error) {
            const failure = new HankoSessionError("refresh_rejected", result.refreshFailure).refreshFailure;
            if (failure?.retryable) {
              // Only an explicitly pre-exchange failure can safely release ownership.
              const released = { ...value, revision: randomUUID() };
              if (!await stored(() => options.store.replace(scope, claimed.revision, released))) throw new HankoSessionError("session_expired");
              throw new HankoSessionError("session_unavailable", failure);
            }
            throw new HankoSessionError(failure?.category === "refresh_outcome_unknown" || failure?.category === "provider_unavailable" ? "refresh_outcome_unknown" : "refresh_rejected", failure);
          }
          tokens = { accessToken: result.accessToken, expiresAt: result.expiresAt,
            ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}), ...(result.logoutToken ? { logoutToken: result.logoutToken } : {}) };
          principal = await verified(tokens, envelope.subject);
        } catch (error) {
          if (error instanceof HankoSessionError && error.category === "session_unavailable") throw error;
          await revoke(id);
          throw error instanceof HankoSessionError ? error : new HankoSessionError("refresh_outcome_unknown");
        }
        const next = { ...value, revision: randomUUID(), leaseUntil: 0, sealed: seal(id, { tokens, subject: envelope.subject }) };
        // A late completion cannot recreate a row removed by logout or a timed-out waiter.
        if (claimed.leaseUntil <= now() || value.expiresAt <= now() || !await stored(() => options.store.replace(scope, claimed.revision, next))) {
          await revoke(id); throw new HankoSessionError("session_expired");
        }
        return { id, expiresAt: value.expiresAt, tokens, principal };
      }
    },
    revoke,
  };
}
export type HankoSessionManager = ReturnType<typeof createHankoSessionManager>;
