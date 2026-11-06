import { HankoOrganizationClient, pathSegment, type HankoOrganizationClientOptions } from "./organization.js";

export interface HankoApplicationMembership {
  subject: string;
  organization: string;
  role: string;
  administrator: boolean;
}
export interface HankoApplicationMembers {
  members: { id: string; name: string; email: string; role: string; manageable?: boolean }[];
  roles: string[];
  administrator: boolean;
}
export interface HankoApplicationInvitation {
  id: string;
  organization: string;
  email: string;
  role: string;
  expires_at: string;
}
export interface HankoApplicationContextSelection {
  membership: HankoApplicationMembership;
  context: HankoApplicationMembership & { root: string; node_path: string[]; roles: string[]; policy_version: number };
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}
export interface HankoApplicationOrganizationOptions extends HankoOrganizationClientOptions {
  realm: string;
  applicationId: string;
}
class ApplicationTransport extends HankoOrganizationClient {
  call<T>(method: string, path: string, body?: unknown, expected = [200], signal?: AbortSignal): Promise<T> {
    return this.request<T>(method, path, body, expected, signal);
  }
}
/** User-session API. Server-approved policies bind each organization and role
 * to application-only groups. Never supply a platform administrator credential.
 */
export class HankoApplicationOrganizationClient {
  readonly #transport: ApplicationTransport;
  readonly #path: string;
  constructor(options: HankoApplicationOrganizationOptions) {
    this.#path = `/api/v1/application-organizations/realms/${segment(options.realm)}/applications/${segment(options.applicationId)}`;
    this.#transport = new ApplicationTransport(options);
  }
  membership(signal?: AbortSignal): Promise<HankoApplicationMembership> {
    return this.#transport.call("GET", `${this.#path}/membership`, undefined, [200], signal);
  }
  memberships(signal?: AbortSignal): Promise<{ memberships: HankoApplicationMembership[] }> {
    return this.#transport.call("GET", `${this.#path}/memberships`, undefined, [200], signal);
  }
  /** The original login token selects a context. Retain it server-side for later selections. */
  async selectMembership(organization: string, signal?: AbortSignal): Promise<HankoApplicationContextSelection> {
    segment(organization);
    return this.#transport.call("POST", `${this.#path}/membership`, { organization }, [200], signal);
  }
  members(organization: string, signal?: AbortSignal): Promise<HankoApplicationMembers> {
    return this.#transport.call("GET", `${this.#organization(organization)}/members`, undefined, [200], signal);
  }
  async changeRole(organization: string, user: string, role: string, signal?: AbortSignal): Promise<void> {
    segment(role);
    await this.#transport.call("PATCH", `${this.#organization(organization)}/members/${segment(user)}`, { role }, [204], signal);
  }
  invite(organization: string, input: { email: string; role: string }, signal?: AbortSignal): Promise<HankoApplicationInvitation> {
    segment(input.role);
    if (input.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.email)) throw new Error("Invalid invitation email");
    return this.#transport.call("POST", `${this.#organization(organization)}/invitations`, input, [201], signal);
  }
  invitation(organization: string, invitation: string, signal?: AbortSignal): Promise<HankoApplicationInvitation> {
    return this.#transport.call("GET", this.#invitation(organization, invitation), undefined, [200], signal);
  }
  async accept(organization: string, invitation: string, signal?: AbortSignal): Promise<void> {
    await this.#transport.call("POST", `${this.#invitation(organization, invitation)}/accept`, {}, [204], signal);
  }
  async revoke(organization: string, invitation: string, signal?: AbortSignal): Promise<void> {
    await this.#transport.call("DELETE", this.#invitation(organization, invitation), undefined, [204], signal);
  }
  #organization(organization: string): string { return `${this.#path}/${segment(organization)}`; }
  #invitation(organization: string, invitation: string): string { return `${this.#organization(organization)}/invitations/${segment(invitation)}`; }
}
function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/u.test(value)) throw new Error("Invalid Hanko API path identifier");
  return pathSegment(value);
}
