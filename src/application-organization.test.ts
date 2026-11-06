import test from "node:test";
import assert from "node:assert/strict";
import { HankoApplicationOrganizationClient } from "./application-organization.js";

const base = "/api/v1/application-organizations/realms/example/applications/product-api";
test("application organization client forwards only the current user token to bounded routes", async () => {
 const calls: { path: string; method: string; body: unknown }[] = [];
 const signal = new AbortController().signal;
 const client = new HankoApplicationOrganizationClient({apiUrl:"https://auth.example.test",realm:"example",applicationId:"product-api",accessToken:()=>"user-access-token",fetch:async(input,init)=>{
   assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer user-access-token");
   assert.equal(init?.redirect,"error");
   assert.ok(init?.signal);
   calls.push({path:new URL(String(input)).pathname,method:init?.method ?? "GET",body:init?.body ? JSON.parse(String(init.body)) : undefined});
   if (init?.method === "POST" && !String(input).endsWith("/accept")) return Response.json({id:"invite"},{status:201});
   return init?.method === "GET" ? Response.json({}) : new Response(null,{status:204});
 }});
 await client.membership(signal);await client.members("cabinet",signal);
 await client.changeRole("cabinet","member","reader",signal);
 await client.invite("cabinet",{email:"invitee@example.test",role:"reader"},signal);
 await client.invitation("cabinet","invite",signal);await client.accept("cabinet","invite",signal);await client.revoke("cabinet","invite",signal);
 assert.deepEqual(calls.map(x=>[x.method,x.path]),[["GET",base+"/membership"],["GET",base+"/cabinet/members"],["PATCH",base+"/cabinet/members/member"],["POST",base+"/cabinet/invitations"],["GET",base+"/cabinet/invitations/invite"],["POST",base+"/cabinet/invitations/invite/accept"],["DELETE",base+"/cabinet/invitations/invite"]]);
 assert.deepEqual(calls[2]?.body,{role:"reader"});
});
test("application client refuses ambiguous targets and preserves authorization failures",async()=>{
 const opts={apiUrl:"https://auth.example.test",realm:"example",applicationId:"product-api",accessToken:()=>"user",fetch:async()=>new Response(null,{status:403})};
 for(const invalid of ["","..","a/b","a%2fb","a?b","a b","a".repeat(256)]){
  assert.throws(()=>new HankoApplicationOrganizationClient({...opts,realm:invalid}));
  await assert.rejects(new HankoApplicationOrganizationClient(opts).changeRole(invalid,"member","reader"));
 }
 await assert.rejects(new HankoApplicationOrganizationClient(opts).membership(),/status 403/);
});
test("approved choices and selection use the platform's user-session route contract", async () => {
 const membership = { subject: "alice", organization: "org", role: "reader", administrator: false };
 const calls: { path: string; method: string; body: unknown }[] = [];
 const client = new HankoApplicationOrganizationClient({ apiUrl: "https://auth.example.test", realm: "example", applicationId: "web", accessToken: () => "original-user-session", fetch: async (input, init) => {
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer original-user-session");
  const path = new URL(String(input)).pathname;
  calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return Response.json(path.endsWith("/memberships") ? { memberships: [membership] } : { membership, context: { ...membership, root: "root", node_path: ["root", "org"], roles: ["member"], policy_version: 1 }, access_token: "bounded-context", token_type: "Bearer", expires_in: 300 });
 }});
 assert.deepEqual((await client.memberships()).memberships, [membership]);
 assert.equal((await client.selectMembership("org")).access_token, "bounded-context");
 assert.deepEqual(calls, [{ path: "/api/v1/application-organizations/realms/example/applications/web/memberships", method: "GET", body: undefined }, { path: "/api/v1/application-organizations/realms/example/applications/web/membership", method: "POST", body: { organization: "org" } }]);
 await assert.rejects(client.selectMembership("../foreign"));
});
