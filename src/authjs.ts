import { getHankoLogoutToken } from "./logout.js";
import type { JWT } from "next-auth/jwt";
import type { OIDCConfig, OIDCUserConfig } from "next-auth/providers";

import { normalizeHankoClientConfig, type HankoClientConfig } from "./config.js";
import { HankoDiscovery, HankoDiscoveryError, type HankoDiscoveryOptions } from "./discovery.js";
import type { HankoClaims } from "./principal.js";
import { HankoHttpError, HankoResponseError, requestHankoJson } from "./http.js";

export { createHankoAuthJsSession } from "./authjs-session.js";
export type { HankoAuthJsSessionOptions, HankoPublicSession } from "./authjs-session.js";

export type HankoAuthJsOverrides = Pick<OIDCUserConfig<HankoAuthJsProfile>, "name" | "style" | "profile" | "account">;

export interface HankoAuthJsProfile extends HankoClaims {
  readonly realm_access?: { readonly roles?: readonly string[] };
}

export interface HankoRefreshableToken extends JWT {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  error?: string | undefined;
  logoutToken?: string | undefined;
  refreshFailure?: HankoRefreshFailure | undefined;
}

export type HankoRefreshFailureCategory =
  | "missing_refresh_token" | "configuration" | "discovery_unavailable" | "discovery_invalid"
  | "rejected_grant" | "client_configuration" | "provider_unavailable"
  | "refresh_outcome_unknown" | "invalid_response" | "coordinator_capacity" | "session_invalidated";

/** Allowlisted diagnostics only. retryable means the token exchange was not attempted. */
export interface HankoRefreshFailure {
  readonly category: HankoRefreshFailureCategory;
  readonly stage: "configuration" | "discovery" | "refresh" | "coordination";
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

export interface HankoRefreshOptions extends HankoDiscoveryOptions {
  readonly discovery?: HankoDiscovery;
  readonly now?: () => number;
  readonly errorCode?: string;
}

export const HANKO_REFRESH_ERROR = "HankoRefreshTokenError";

export function createHankoAuthJsProvider(
  config: HankoClientConfig,
  overrides: HankoAuthJsOverrides = {},
): OIDCConfig<HankoAuthJsProfile> {
  const allowed = new Set(["name", "style", "profile", "account"]);
  if (Object.keys(overrides).some((key) => !allowed.has(key))) {
    throw new Error("Unsupported Hanko Auth.js option");
  }
  const normalized = normalizeHankoClientConfig(config);
  return {
    id: "hanko",
    name: "Hanko",
    type: "oidc",
    checks: ["pkce", "state", "nonce"],
    options: {
      ...overrides,
      clientId: normalized.clientId,
      ...(normalized.clientSecret ? { clientSecret: normalized.clientSecret } : {}),
      issuer: normalized.issuer,
      client: { token_endpoint_auth_method: normalized.clientSecret ? "client_secret_post" : "none" },
      checks: ["pkce", "state", "nonce"],
    },
  };
}

function failedRefresh<T extends HankoRefreshableToken>(
  token: T,
  errorCode: string,
  refreshFailure: HankoRefreshFailure,
): T & HankoRefreshableToken {
  // Compatibility: old fields remain on an errored result. Callers must fail closed.
  return { ...token, error: errorCode, refreshFailure };
}

function discoveryFailure(error: unknown): HankoRefreshFailure {
  if (error instanceof HankoHttpError) {
    return { category: "discovery_unavailable", stage: "discovery", retryable: error.status === 429 || error.status >= 500, httpStatus: error.status };
  }
  if (error instanceof HankoDiscoveryError || error instanceof HankoResponseError) {
    return { category: "discovery_invalid", stage: "discovery", retryable: false };
  }
  return { category: "discovery_unavailable", stage: "discovery", retryable: true };
}

function exchangeFailure(status: number | undefined, oauthError?: unknown): HankoRefreshFailure {
  if (status === 400 && oauthError === "invalid_grant") {
    return { category: "rejected_grant", stage: "refresh", retryable: false, httpStatus: status };
  }
  if (status === 401 || status === 403 || oauthError === "invalid_client" || oauthError === "unauthorized_client") {
    return { category: "client_configuration", stage: "refresh", retryable: false, ...(status ? { httpStatus: status } : {}) };
  }
  if (status && (status === 429 || status >= 500)) {
    // Even a 503 can arrive after an upstream consumed the single-use token.
    return { category: "provider_unavailable", stage: "refresh", retryable: false, httpStatus: status };
  }
  return { category: "refresh_outcome_unknown", stage: "refresh", retryable: false, ...(status ? { httpStatus: status } : {}) };
}

export async function refreshHankoAccessToken<T extends HankoRefreshableToken>(
  token: T,
  config: HankoClientConfig,
  options: HankoRefreshOptions = {},
): Promise<T & HankoRefreshableToken> {
  token = { ...token };
  options = { ...options };
  const errorCode = options.errorCode ?? HANKO_REFRESH_ERROR;
  if (!token.refreshToken) {
    return failedRefresh(token, errorCode, { category: "missing_refresh_token", stage: "configuration", retryable: false });
  }

  let normalized: HankoClientConfig;
  try { normalized = normalizeHankoClientConfig(config); }
  catch { return failedRefresh(token, errorCode, { category: "configuration", stage: "configuration", retryable: false }); }

  let tokenEndpoint: string;
  try {
    const discovery = options.discovery ?? new HankoDiscovery(normalized.issuer, options);
    const metadata = await discovery.metadata(["token_endpoint"]);
    if (metadata.issuer !== normalized.issuer) throw new HankoDiscoveryError("Hanko refresh discovery issuer does not match the configured issuer");
    tokenEndpoint = discovery.endpoint(metadata, "token_endpoint");
  } catch (error) { return failedRefresh(token, errorCode, discoveryFailure(error)); }

  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: normalized.clientId, refresh_token: token.refreshToken });
  if (normalized.clientSecret) body.set("client_secret", normalized.clientSecret);
  let status: number | undefined;
  try {
    const transport = options.fetch ?? globalThis.fetch;
    // Error JSON is read only through the same bounded transport and is never returned.
    const refreshed = await requestHankoJson<unknown>(tokenEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body, redirect: "error",
    }, {
      ...options,
      fetch: async (input, init) => { const response = await transport(input, init); status = response.status; return response; },
    }, [200, ...Array.from({ length: 200 }, (_, index) => index + 400)]);
    const packet = refreshed && typeof refreshed === "object" && !Array.isArray(refreshed)
      ? refreshed as Record<string, unknown> : {};
    if (status !== 200) return failedRefresh(token, errorCode, exchangeFailure(status, packet.error));
    if (typeof packet.access_token !== "string" || !packet.access_token.trim() ||
        typeof packet.expires_in !== "number" || !Number.isSafeInteger(packet.expires_in) || packet.expires_in < 1) {
      return failedRefresh(token, errorCode, { category: "invalid_response", stage: "refresh", retryable: false });
    }
    const expiresAt = Math.floor((options.now ?? Date.now)() / 1000) + packet.expires_in;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      return failedRefresh(token, errorCode, { category: "invalid_response", stage: "refresh", retryable: false });
    }
    return {
      ...token,
      accessToken: packet.access_token,
      logoutToken: getHankoLogoutToken(packet) ?? token.logoutToken,
      refreshToken: typeof packet.refresh_token === "string" && packet.refresh_token ? packet.refresh_token : token.refreshToken,
      expiresAt, error: undefined, refreshFailure: undefined,
    };
  } catch (error) {
    if (status === 200 && error instanceof HankoResponseError) {
      return failedRefresh(token, errorCode, { category: "invalid_response", stage: "refresh", retryable: false });
    }
    return failedRefresh(token, errorCode, exchangeFailure(error instanceof HankoHttpError ? error.status : status));
  }
}

export interface HankoRefreshCoordinatorOptions {
  /** Completed outcomes are retained briefly so late old-cookie reads reuse one result. */
  readonly reuseWindowMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export interface HankoRefreshCoordinator {
  refresh<T extends HankoRefreshableToken>(token: T, config: HankoClientConfig, options?: HankoRefreshOptions): Promise<T & HankoRefreshableToken>;
  invalidate(token: Pick<HankoRefreshableToken, "refreshToken">, config: HankoClientConfig): Promise<boolean>;
  /** Invalidates known lineages, including requests still in flight. */
  clear(): void;
}

type RefreshDelta = Pick<HankoRefreshableToken, "accessToken" | "refreshToken" | "expiresAt" | "logoutToken" | "error" | "refreshFailure">;
interface RefreshEntry {
  promise: Promise<RefreshDelta>;
  completed: boolean;
  invalidated: boolean;
  expires: number;
  result?: RefreshDelta;
}

const invalidatedFailure: HankoRefreshFailure = { category: "session_invalidated", stage: "coordination", retryable: false };

/**
 * Process-local rotation coordination. Instantiate once per application process.
 * This is not a session store, distributed lock or revocation service.
 */
export function createHankoRefreshCoordinator(options: HankoRefreshCoordinatorOptions = {}): HankoRefreshCoordinator {
  const reuseWindow = options.reuseWindowMs ?? 10_000;
  const capacity = options.maxEntries ?? 256;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(reuseWindow) || reuseWindow < 1 || reuseWindow > 60_000 ||
      !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
    throw new Error("Invalid Hanko refresh coordination limits");
  }
  const entries = new Map<string, RefreshEntry>();
  let epoch = 0;
  function prune(): void {
    for (const [key, entry] of entries) if (entry.completed && entry.expires <= now()) entries.delete(key);
  }
  async function keyFor(token: Pick<HankoRefreshableToken, "refreshToken">, config: HankoClientConfig): Promise<string | undefined> {
    if (!token.refreshToken) return undefined;
    try {
      const client = normalizeHankoClientConfig(config);
      const input = JSON.stringify([client.issuer, client.clientId, client.clientSecret ?? "", token.refreshToken]);
      const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    } catch { return undefined; }
  }
  function invalidateEntry(entry: RefreshEntry): void {
    entry.invalidated = true;
    entry.expires = now() + reuseWindow;
    entry.result = { error: HANKO_REFRESH_ERROR, refreshFailure: invalidatedFailure };
  }
  return {
    async refresh(token, config, refreshOptions = {}) {
      token = { ...token };
      refreshOptions = { ...refreshOptions };
      try { config = normalizeHankoClientConfig(config); }
      catch { return failedRefresh(token, refreshOptions.errorCode ?? HANKO_REFRESH_ERROR, { category: "configuration", stage: "configuration", retryable: false }); }
      const startedEpoch = epoch;
      const key = await keyFor(token, config);
      if (startedEpoch !== epoch) return failedRefresh(token, refreshOptions.errorCode ?? HANKO_REFRESH_ERROR, { ...invalidatedFailure });
      if (!key) return failedRefresh(token, refreshOptions.errorCode ?? HANKO_REFRESH_ERROR, { category: token.refreshToken ? "configuration" : "missing_refresh_token", stage: "configuration", retryable: false });
      prune();
      let entry = entries.get(key);
      if (!entry) {
        // Never evict pending work: that could replay a consuming token exchange.
        if (entries.size >= capacity) return failedRefresh(token, refreshOptions.errorCode ?? HANKO_REFRESH_ERROR, { category: "coordinator_capacity", stage: "coordination", retryable: true });
        entry = { completed: false, invalidated: false, expires: Infinity, promise: Promise.resolve({}) };
        entries.set(key, entry);
        const current = entry;
        // Never let a first caller's fallback hint or private JWT claims enter a shared result.
        current.promise = refreshHankoAccessToken({ refreshToken: token.refreshToken }, config, refreshOptions).then(result => {
          const delta: RefreshDelta = result.error
            ? { error: HANKO_REFRESH_ERROR, refreshFailure: result.refreshFailure }
            : { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt,
                ...(result.logoutToken !== undefined ? { logoutToken: result.logoutToken } : {}) };
          current.completed = true;
          if (!current.invalidated) {
            current.result = delta;
            current.expires = Math.min(now() + reuseWindow, !delta.error && delta.expiresAt ? delta.expiresAt * 1000 : Infinity);
          }
          return current.result ?? delta;
        });
      }
      const delta = entry.result ?? await entry.promise;
      if (entry.invalidated) return failedRefresh(token, refreshOptions.errorCode ?? HANKO_REFRESH_ERROR, { ...invalidatedFailure });
      if (delta.error) return failedRefresh(token, refreshOptions.errorCode ?? HANKO_REFRESH_ERROR, { ...delta.refreshFailure! });
      return { ...token, ...delta, error: undefined, refreshFailure: undefined };
    },
    async invalidate(token, config) {
      const key = await keyFor(token, config);
      if (!key) return false;
      prune();
      const existing = entries.get(key);
      if (existing) { invalidateEntry(existing); return true; }
      if (entries.size >= capacity) return false;
      const result: RefreshDelta = { error: HANKO_REFRESH_ERROR, refreshFailure: invalidatedFailure };
      entries.set(key, { completed: true, invalidated: true, expires: now() + reuseWindow, result, promise: Promise.resolve(result) });
      return true;
    },
    clear() { epoch += 1; for (const entry of entries.values()) invalidateEntry(entry); },
  };
}
