import assert from "node:assert/strict";
import { test } from "node:test";
import { requireHankoApplicationAccess, HankoAccessError } from "./access-diagnostics.js";
import type { HankoPrincipal } from "./principal.js";
import { readFileSync } from "node:fs";
import { resolveHankoApplicationAccess } from "./access.js";
const principal = (claims: Record<string, unknown>): HankoPrincipal => ({ issuer: "https://auth.example.test", subject: "alice", audiences: ["api"], claims });
test("portable application-access contract shared with the Go ADK", () => {
  const cases = JSON.parse(readFileSync(new URL("../testdata/application-access-contract.json", import.meta.url), "utf8")) as { name: string; audience: string; clientId?: string; claims: Record<string, unknown>; denial?: string; roles?: string[] }[];
  for (const item of cases) {
    const resolve = () => requireHankoApplicationAccess(principal(item.claims), item.audience, [], item.clientId ? { clientId: item.clientId } : {});
    if (item.denial) assert.throws(resolve, { category: item.denial }, item.name);
    else assert.deepEqual(resolve().roles, item.roles, item.name);
    if (Object.hasOwn(item.claims, "hanko_application_context") && item.audience === "api") {
      assert.deepEqual(resolveHankoApplicationAccess(principal(item.claims), item.audience, item.clientId ? { clientId: item.clientId } : {}).roles, item.roles ?? [], item.name);
    }
  }
});
test("strict application access identifies denials without leaking claims or using global roles", () => {
  const cases = [
    [{ realm_access: { roles: ["admin"] } }, "application_roles_missing"],
    [{ organization: [] }, "organization_malformed"],
    [{ organization: { a: {}, b: {} } }, "organization_ambiguous"],
    [{ organization: { "bad/path": {} } }, "organization_malformed"],
    [{ organization: { a: null } }, "organization_malformed"],
    [{ resource_access: { api: { roles: "admin-private" } } }, "application_roles_malformed"],
    [{ resource_access: { api: { roles: [] } } }, "required_role_missing"],
    [{ resource_access: { api: { roles: ["member"] } } }, "required_role_missing"],
    [{ organization: { a: { realm_access: { roles: ["admin"] } } }, resource_access: { api: { roles: ["admin"] } } }, "application_roles_missing"],
  ] as const;
  for (const [claims, category] of cases) {
    assert.throws(() => requireHankoApplicationAccess(principal(claims), "api", ["admin"]), error => error instanceof HankoAccessError && error.category === category && error.status === 403 && !error.message.includes("admin-private"));
  }
  assert.throws(() => requireHankoApplicationAccess(principal({}), "other"), { category: "audience_mismatch" });
  assert.throws(() => requireHankoApplicationAccess(principal({}), ""), { category: "audience_mismatch" });
});
test("one selected organization supplies only the target application's roles", () => {
  const result = requireHankoApplicationAccess(principal({ organization: { selected: { id: "org-1", resource_access: { api: { roles: ["member", "member"] }, other: { roles: ["admin"] } } } }, resource_access: { api: { roles: ["admin"] } } }), "api", ["member"]);
  assert.deepEqual(result.roles, ["member"]);
  assert.deepEqual(result.organization, { alias: "selected", id: "org-1", groups: [] });
  assert.deepEqual(requireHankoApplicationAccess(principal({ resource_access: { api: { roles: ["member"] } } }), "api").roles, ["member"]);
});
