import { normalizeHankoIssuer } from "./config.js";
import { requestHankoJson, type HankoHttpOptions } from "./http.js";
export type { HankoFetch } from "./http.js";

export interface HankoOidcMetadata {
  readonly issuer?: string;
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly jwks_uri?: string;
  readonly end_session_endpoint?: string;
}

export type HankoMetadataEndpoint = Exclude<keyof HankoOidcMetadata, "issuer">;
export type HankoDiscoveryOptions = HankoHttpOptions;

export class HankoDiscoveryError extends Error {}

function validateEndpoint(
  value: unknown,
  field: HankoMetadataEndpoint,
  issuer: URL,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HankoDiscoveryError(`Hanko discovery does not expose ${field}`);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new HankoDiscoveryError(`Hanko discovery ${field} must be an absolute URL`);
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new HankoDiscoveryError(`Hanko discovery ${field} contains forbidden URL components`);
  }
  if (endpoint.protocol !== issuer.protocol) {
    throw new HankoDiscoveryError(`Hanko discovery ${field} must use the issuer protocol`);
  }
  if (endpoint.origin !== issuer.origin) {
    throw new HankoDiscoveryError(`Hanko discovery ${field} must use the issuer origin`);
  }
  return endpoint.toString();
}

export class HankoDiscovery {
  readonly #issuer: string;
  readonly #options: HankoDiscoveryOptions;
  #metadataPromise: Promise<HankoOidcMetadata> | undefined;

  constructor(issuer: string, options: HankoDiscoveryOptions = {}) {
    this.#issuer = normalizeHankoIssuer(issuer);
    this.#options = { ...options };
  }

  async metadata(requiredEndpoints: readonly HankoMetadataEndpoint[] = []): Promise<HankoOidcMetadata> {
    if (!this.#metadataPromise) {
      this.#metadataPromise = this.#load();
      void this.#metadataPromise.catch(() => {
        this.#metadataPromise = undefined;
      });
    }

    const metadata = await this.#metadataPromise;
    const issuer = new URL(this.#issuer);
    for (const field of requiredEndpoints) {
      validateEndpoint(metadata[field], field, issuer);
    }
    return metadata;
  }

  endpoint(metadata: HankoOidcMetadata, field: HankoMetadataEndpoint): string {
    return validateEndpoint(metadata[field], field, new URL(this.#issuer));
  }

  async #load(): Promise<HankoOidcMetadata> {
    const metadata = await requestHankoJson<HankoOidcMetadata>(`${this.#issuer}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
    }, this.#options);
    if (!metadata || typeof metadata !== "object" || metadata.issuer !== this.#issuer) {
      throw new HankoDiscoveryError("Hanko discovery issuer does not match the configured issuer");
    }
    return Object.freeze(metadata);
  }
}
