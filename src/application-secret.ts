import { HankoOrganizationClient, pathSegment, realmPath, type HankoOrganizationClientOptions } from "./organization.js";

export interface HankoApplicationMetadata {
  readonly clientId: string;
  readonly name: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly redirectUris: readonly string[];
}

/** A one-time value: show it once, never log or persist it in plain text. */
export interface HankoApplicationSecret {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly rotatedAt: string;
}

export interface HankoApplicationSecretClientOptions extends HankoOrganizationClientOptions {
  readonly realm: string;
  /** The only applications this client may read or rotate. */
  readonly clientIds: readonly string[];
}

class SecretTransport extends HankoOrganizationClient {
  call<T>(method: string, path: string): Promise<T> {
    return this.request<T>(method, path);
  }
}

/** Backend-only client that rotates the secret of named confidential applications.
 * It is bound at construction to one realm and an allowlist of client IDs, so a
 * product dashboard can rotate its own clients without a general application API.
 * The API still enforces the caller's authority on every request.
 */
export class HankoApplicationSecretClient {
  readonly #transport: SecretTransport;
  readonly #realm: string;
  readonly #clientIds: ReadonlySet<string>;

  constructor(options: HankoApplicationSecretClientOptions) {
    pathSegment(options.realm);
    if (!Array.isArray(options.clientIds) || options.clientIds.length === 0) {
      throw new Error("Hanko application secret client needs at least one client ID");
    }
    for (const clientId of options.clientIds) pathSegment(clientId);
    this.#realm = options.realm;
    this.#clientIds = new Set(options.clientIds);
    this.#transport = new SecretTransport(options);
  }

  /** Application metadata without any secret value. */
  async getApplication(clientId: string): Promise<HankoApplicationMetadata> {
    const app = await this.#transport.call<Partial<HankoApplicationMetadata> | undefined>("GET", this.#path(clientId));
    if (!app || app.clientId !== clientId || typeof app.enabled !== "boolean") {
      throw new Error("Invalid Hanko application response");
    }
    return {
      clientId: app.clientId,
      name: typeof app.name === "string" ? app.name : "",
      type: typeof app.type === "string" ? app.type : "",
      enabled: app.enabled,
      redirectUris: Array.isArray(app.redirectUris) ? app.redirectUris : [],
    };
  }

  /** Issues a new secret; the previous one stops working. */
  async rotateSecret(clientId: string): Promise<HankoApplicationSecret> {
    const secret = await this.#transport.call<Partial<HankoApplicationSecret> | undefined>("POST", `${this.#path(clientId)}/secret/rotate`);
    if (!secret || secret.clientId !== clientId || typeof secret.clientSecret !== "string" || !secret.clientSecret ||
        typeof secret.rotatedAt !== "string" || Number.isNaN(Date.parse(secret.rotatedAt))) {
      throw new Error("Invalid Hanko application secret response");
    }
    return { clientId: secret.clientId, clientSecret: secret.clientSecret, rotatedAt: secret.rotatedAt };
  }

  #path(clientId: string): string {
    if (!this.#clientIds.has(clientId)) throw new Error("Hanko application is not allowed for this client");
    return `${realmPath(this.#realm)}/apps/${pathSegment(clientId)}`;
  }
}
