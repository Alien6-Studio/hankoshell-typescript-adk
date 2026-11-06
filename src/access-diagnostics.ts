import type { HankoPrincipal } from "./principal.js";
import type { HankoApplicationAccess } from "./access.js";

export type HankoAccessDenial = "audience_mismatch" | "organization_malformed" | "organization_ambiguous" | "application_binding_mismatch" | "application_roles_missing" | "application_roles_malformed" | "required_role_missing";
export interface HankoApplicationBinding { readonly clientId?: string }
export class HankoAccessError extends Error {
  readonly status = 403;
  constructor(readonly category: HankoAccessDenial) { super(`Hanko application access denied (${category})`); }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** After verification. Only the target application's roles authorize this application. */
export function requireHankoApplicationAccess(
  principal: HankoPrincipal,
  applicationId: string,
  requiredRoles: readonly string[] = [],
  binding: HankoApplicationBinding = {},
): HankoApplicationAccess {
  if (!applicationId.trim() || !principal.audiences.includes(applicationId)) throw new HankoAccessError("audience_mismatch");
  let claims: Record<string, unknown> = principal.claims;
  let organization: HankoApplicationAccess["organization"];
  let roleClient = applicationId;
  if (Object.hasOwn(claims, "hanko_application_context")) {
    const context = record(claims.hanko_application_context);
    if (!binding.clientId || claims.azp !== binding.clientId) throw new HankoAccessError("application_binding_mismatch");
    const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/u.test(value);
    if (!context || Object.hasOwn(claims, "organization") || context.subject !== principal.subject ||
        !validId(context.organization) || !validId(context.root) || !validId(context.role) ||
        typeof context.administrator !== "boolean" || !Number.isSafeInteger(context.policy_version) || Number(context.policy_version) < 1 ||
        !Array.isArray(context.node_path) || context.node_path.length > 128 || !context.node_path.every(validId) ||
        context.node_path[0] !== context.root || context.node_path.at(-1) !== context.organization) throw new HankoAccessError("organization_malformed");
    organization = { alias: context.organization, id: context.organization, groups: [] };
    roleClient = binding.clientId;
  } else if (Object.hasOwn(claims, "organization")) {
    const entries = Object.entries(record(claims.organization) ?? {});
    if (entries.length > 1) throw new HankoAccessError("organization_ambiguous");
    const [alias, value] = entries[0] ?? [];
    const context = record(value);
    if (!alias?.trim() || alias.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(alias) || !context) throw new HankoAccessError("organization_malformed");
    claims = context;
    organization = { alias, groups: [], ...(typeof context.id === "string" && context.id.length <= 255 ? { id: context.id } : {}) };
  }
  const client = record(record(claims.resource_access)?.[roleClient]);
  if (!client || !Object.hasOwn(client, "roles")) throw new HankoAccessError("application_roles_missing");
  const roles = client.roles;
  if (!Array.isArray(roles) || roles.length > 128 || roles.some(role => typeof role !== "string" || !role || role.length > 1024 || /[\u0000-\u001f\u007f]/u.test(role))) throw new HankoAccessError("application_roles_malformed");
  const context = record(claims.hanko_application_context);
  if (context && (!Array.isArray(context.roles) || context.roles.length !== roles.length || !context.roles.every(role => roles.includes(role)) || !roles.every(role => (context.roles as unknown[]).includes(role)))) throw new HankoAccessError("application_roles_malformed");
  if (!roles.length || (requiredRoles.length && !requiredRoles.some(role => roles.includes(role)))) throw new HankoAccessError("required_role_missing");
  return { subject: principal.subject, issuer: principal.issuer, roles: [...new Set(roles as string[])], ...(organization ? { organization } : {}) };
}
