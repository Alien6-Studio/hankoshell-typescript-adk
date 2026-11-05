/** Server-only Auth.js 5 example. Review the deployment contract in README first. */
import type { NextAuthConfig } from "next-auth";
import { loadHankoClientConfig, getHankoLogoutToken } from "@alien6-studio/hankoshell-typescript-adk";
import {
  createHankoAuthJsProvider, createHankoRefreshCoordinator,
  type HankoRefreshableToken,
} from "@alien6-studio/hankoshell-typescript-adk/authjs";

// One coordinator for the process, never one per request or JWT callback.
const refreshes = createHankoRefreshCoordinator();
const renewalMarginSeconds = 30;
interface SessionToken extends HankoRefreshableToken { refreshRetryAt?: number | undefined }

export function createExampleAuthConfig(
  environment: Readonly<Record<string, string | undefined>>,
  allowRefresh = true,
): NextAuthConfig {
  const client = loadHankoClientConfig(environment);
  const secret = environment.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("The session example requires an independent AUTH_SECRET of at least 32 characters");
  return {
    secret,
    session: { strategy: "jwt", maxAge: 3600 },
    providers: [createHankoAuthJsProvider(client)],
    callbacks: {
      async jwt({ token, account }) {
        const session = token as SessionToken;
        if (account) {
          if (typeof account.access_token !== "string" || !account.access_token ||
              typeof account.expires_at !== "number" || !Number.isSafeInteger(account.expires_at) ||
              account.expires_at <= Math.floor(Date.now() / 1000)) {
            return { ...session, accessToken: undefined, refreshToken: undefined, error: "ReauthenticationRequired" };
          }
          return {
            ...session, accessToken: account.access_token, refreshToken: account.refresh_token,
            expiresAt: account.expires_at, logoutToken: getHankoLogoutToken(account),
            error: undefined, refreshFailure: undefined, refreshRetryAt: undefined,
          };
        }
        if (!allowRefresh) return session; // Render-only reads must never rotate a cookie they cannot write.
        if (session.error === "ReauthenticationRequired") return session;
        if (session.refreshRetryAt && Date.now() < session.refreshRetryAt) return session;
        if (session.accessToken && session.expiresAt && Date.now() < (session.expiresAt - renewalMarginSeconds) * 1000) return session;
        const result = await refreshes.refresh(session, client);
        if (!result.error) return { ...result, refreshRetryAt: undefined };
        const retryable = result.refreshFailure?.retryable === true;
        return {
          ...session, accessToken: undefined, expiresAt: undefined,
          // Retry is allowed only if the consuming POST was definitely not attempted.
          refreshToken: retryable ? session.refreshToken : undefined,
          error: retryable ? "AuthenticationTemporarilyUnavailable" : "ReauthenticationRequired",
          refreshFailure: result.refreshFailure,
          refreshRetryAt: retryable ? Date.now() + 10_000 : undefined,
        };
      },
      session({ session, token }) {
        const privateToken = token as SessionToken;
        const valid = !privateToken.error && !!privateToken.accessToken && typeof privateToken.expiresAt === "number" && Date.now() < privateToken.expiresAt * 1000;
        return {
          expires: session.expires,
          user: { name: typeof token.name === "string" ? token.name : null, email: typeof token.email === "string" ? token.email : null },
          ...(valid ? { accessToken: privateToken.accessToken, accessTokenExpiresAt: privateToken.expiresAt } : { error: privateToken.error ?? "ReauthenticationRequired" }),
        };
      },
    },
  };
}

// Host wiring:
// const writable = NextAuth(createExampleAuthConfig(process.env));
// export const { handlers } = writable;           // Browser /session writes rotated cookies.
// export const withSession = writable.auth;       // auth(handler) wrapper forwards Set-Cookie.
// export const readSession = NextAuth(createExampleAuthConfig(process.env, false)).auth;
// await readSession() is render-only. Never use writable.auth() for a render read.
// Add host CSRF/origin checks, exact redirect validation and durable logout fencing.
// This example alone does not implement distributed sessions or session revocation.
