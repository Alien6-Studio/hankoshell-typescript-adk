import type { HankoPrincipal } from "./principal.js";
import { requireHankoApplicationAccess, type HankoApplicationBinding } from "./access-diagnostics.js";

export interface HankoApplicationAccess {
  readonly subject: string;
  readonly issuer: string;
  readonly roles: readonly string[];
  readonly organization?: {
    readonly alias: string;
    readonly id?: string;
    readonly groups: readonly string[];
  };
}

/** After signature verification: one application, one active organization, no cross-tenant role union. */
export function resolveHankoApplicationAccess(
  principal: HankoPrincipal,
  applicationId: string,
  binding: HankoApplicationBinding = {},
): HankoApplicationAccess {
  if (!applicationId || !principal.audiences.includes(applicationId))
    throw new Error("Application audience mismatch");
  const base = { subject: principal.subject, issuer: principal.issuer };
  const claims = principal.claims;
  if (Object.hasOwn(claims, "hanko_application_context")) {
    try { return requireHankoApplicationAccess(principal, applicationId, [], binding); }
    catch { return { ...base, roles: [] }; }
  }
  if (Object.hasOwn(claims, "organization")) {
    const organizations = record(claims.organization);
    const entries = organizations ? Object.entries(organizations) : [];
    if (entries.length !== 1) return { ...base, roles: [] };
    const [alias, raw] = entries[0]!;
    const organization = record(raw);
    if (
      !organization ||
      !alias.trim() ||
      alias.length > 255 ||
      /[/\\\u0000-\u001f\u007f]/u.test(alias)
    )
      return { ...base, roles: [] };
    const client = record(
      record(organization.resource_access)?.[applicationId],
    );
    const roles =
      client && Object.hasOwn(client, "roles")
        ? strings(client.roles)
        : strings(record(organization.realm_access)?.roles);
    const id =
      typeof organization.id === "string" && organization.id.length <= 255
        ? organization.id
        : undefined;
    return {
      ...base,
      roles,
      organization: {
        alias,
        ...(id ? { id } : {}),
        groups: strings(organization.groups),
      },
    };
  }
  return {
    ...base,
    roles: [
      ...new Set([
        ...strings(record(claims.realm_access)?.roles),
        ...strings(
          record(record(claims.resource_access)?.[applicationId])?.roles,
        ),
      ]),
    ],
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 1024 &&
        !/[\u0000-\u001f\u007f]/u.test(item),
    )
    ? [...new Set(value as string[])]
    : [];
}
