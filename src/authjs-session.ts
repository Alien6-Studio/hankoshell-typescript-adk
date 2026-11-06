import type { NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { HankoClientConfig } from "./config.js";
import { createHankoAuthJsProvider, refreshHankoAccessToken, type HankoRefreshFailure } from "./authjs.js";
import { getHankoLogoutToken } from "./logout.js";
import { createHankoSessionManager, HankoSessionError, type HankoSessionManagerOptions, type HankoSessionFailure } from "./sessions.js";
import { resolveHankoApplicationAccess } from "./access.js";

export interface HankoPublicSession extends Session {
  readonly issuer: string;
  readonly sub: string;
  readonly roles: readonly string[];
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: number;
  readonly error?: "ReauthenticationRequired" | "SessionTemporarilyUnavailable";
}
export interface HankoAuthJsSessionOptions extends Omit<HankoSessionManagerOptions, "client" | "refresh"> {
  readonly client: HankoClientConfig | (() => HankoClientConfig | Promise<HankoClientConfig>);
  readonly basePath?: string;
  readonly onDiagnostic?: (event: { stage: "sign_in" | "session" | "sign_out"; category: HankoSessionFailure; refreshFailure?: HankoRefreshFailure }) => void;
}

/** Supported Auth.js callbacks; JWT cookies contain a session pointer, never provider tokens. */
export function createHankoAuthJsSession(options: HankoAuthJsSessionOptions) {
  const diagnostic = (stage: "sign_in" | "session" | "sign_out", error: unknown): HankoSessionFailure => {
    const category = error instanceof HankoSessionError ? error.category : "session_unavailable";
    try { options.onDiagnostic?.({ stage, category, ...(error instanceof HankoSessionError && error.refreshFailure ? { refreshFailure: error.refreshFailure } : {}) }); } catch { /* Observability cannot change session authority. */ }
    return category;
  };
  const configuration = async () => typeof options.client === "function" ? await options.client() : options.client;
  let sharedManager: Promise<ReturnType<typeof createHankoSessionManager>> | undefined;
  const manager = () => sharedManager ??= configuration().then(client => createHankoSessionManager({ ...options, client,
    refresh: async tokens => {
      const current = await configuration();
      if (current.issuer !== client.issuer || current.clientId !== client.clientId) throw new HankoSessionError("session_expired");
      return refreshHankoAccessToken({ ...tokens }, current, options.now ? { now: options.now } : {});
    },
  })).catch(error => { sharedManager = undefined; throw error; });
  const callbacks = {
    async jwt({ token, account, profile }: Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>>[0]): Promise<JWT> {
      if (!account) return typeof token.hankoSessionId === "string" ? { hankoSessionId: token.hankoSessionId } : {};
      if (account.provider !== "hanko" || !account.access_token || !account.expires_at || typeof profile?.sub !== "string") return {};
      let session;
      try { session = await (await manager()).create({ accessToken: account.access_token, expiresAt: account.expires_at,
        ...(account.refresh_token ? { refreshToken: account.refresh_token } : {}),
        ...(getHankoLogoutToken(account) ? { logoutToken: getHankoLogoutToken(account) } : {}),
      }); } catch (error) { throw new HankoSessionError(diagnostic("sign_in", error)); }
      if (session.principal.subject !== profile.sub) {
        await (await manager()).revoke(session.id);
        return {};
      }
      return { hankoSessionId: session.id };
    },
    async session({ session, token }: { session: Session; token: JWT }): Promise<HankoPublicSession> {
      const unavailable = (error: HankoPublicSession["error"]): HankoPublicSession => ({ expires: session.expires, user: {}, issuer: "", sub: "", roles: [], ...(error ? { error } : {}) });
      if (typeof token.hankoSessionId !== "string") return unavailable("ReauthenticationRequired");
      try {
        const current = await (await manager()).read(token.hankoSessionId);
        const access = resolveHankoApplicationAccess(current.principal, options.audience);
        return { expires: new Date(current.expiresAt).toISOString(),
          user: { ...(current.principal.name ? { name: current.principal.name } : {}), ...(current.principal.email ? { email: current.principal.email } : {}) },
          issuer: current.principal.issuer, sub: current.principal.subject, roles: access.roles,
          accessToken: current.tokens.accessToken, accessTokenExpiresAt: current.tokens.expiresAt,
        };
      } catch (error) {
        return unavailable(diagnostic("session", error) === "session_unavailable" ? "SessionTemporarilyUnavailable" : "ReauthenticationRequired");
      }
    },
  };
  const revoke = async (token: JWT): Promise<void> => {
    try { if (typeof token.hankoSessionId === "string") await (await manager()).revoke(token.hankoSessionId); }
    catch (error) { throw new HankoSessionError(diagnostic("sign_out", error)); }
  };
  return {
    callbacks,
    revoke,
    /** Read the server-only logout hint before revoking the local session. */
    async logoutToken(token: JWT): Promise<string | undefined> {
      if (typeof token.hankoSessionId !== "string") return undefined;
      try { return (await (await manager()).read(token.hankoSessionId)).tokens.logoutToken; }
      catch { return undefined; }
    },
    async config(): Promise<NextAuthConfig> {
      return { secret: options.secret, ...(options.basePath ? { basePath: options.basePath } : {}),
        session: { strategy: "jwt", maxAge: options.maxAgeSeconds ?? 8 * 3600 },
        providers: [createHankoAuthJsProvider(await configuration())], callbacks,
        events: { async signOut(message) { if ("token" in message && message.token) await revoke(message.token); } },
        // Provider errors can retain credential-bearing response objects. Log only host-approved diagnostics.
        logger: { error() {}, warn() {}, debug() {} },
      };
    },
  };
}
