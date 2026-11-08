import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HankoApplicationSecretClient } from "./application-secret.js";
import type { HankoFetch } from "./http.js";

interface ContractCase {
  operation: "getApplication" | "rotateSecret"; args: [string]; method: string; path: string;
  status: number; response?: unknown; result?: unknown;
}
const cases = JSON.parse(readFileSync(new URL("../testdata/application-secret-contract.json", import.meta.url), "utf8")) as ContractCase[];

const secretClient = (fetch: HankoFetch, accessToken: () => string = () => "current-token") =>
  new HankoApplicationSecretClient({ apiUrl: "https://api.example.test", accessToken, realm: "example", clientIds: ["example-assistant"], fetch });

for (const entry of cases) {
  test(`shared application secret contract: ${entry.operation}`, async () => {
    let calls = 0;
    const client = secretClient(async (input, init) => {
      calls++;
      assert.equal(String(input), `https://api.example.test${entry.path}`);
      assert.equal(init?.method, entry.method);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer current-token");
      return Response.json(entry.response, { status: entry.status });
    });
    assert.deepEqual(await client[entry.operation](...entry.args), entry.result);
    assert.equal(calls, 1);
  });
}

test("application secret client only reaches its allowlisted applications", async () => {
  const client = secretClient(async () => { throw new Error("must not send"); }, () => { throw new Error("must not resolve"); });
  await assert.rejects(client.rotateSecret("other-app"), /not allowed/);
  await assert.rejects(client.getApplication("other-app"), /not allowed/);
  for (const value of ["", ".", "..", "x/y", "x\\y", "x\ny", " example"]) {
    assert.throws(() => new HankoApplicationSecretClient({ apiUrl: "https://api.example.test", accessToken: () => "t", realm: value, clientIds: ["example-assistant"] }), /path identifier/);
    assert.throws(() => new HankoApplicationSecretClient({ apiUrl: "https://api.example.test", accessToken: () => "t", realm: "example", clientIds: [value] }), /path identifier/);
  }
  assert.throws(() => new HankoApplicationSecretClient({ apiUrl: "https://api.example.test", accessToken: () => "t", realm: "example", clientIds: [] }), /at least one/);
});

test("application secret client keeps refusals and provider details out of errors", async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    const client = secretClient(async () => new Response("private provider detail", { status }));
    await assert.rejects(client.rotateSecret("example-assistant"), (error: Error) => error.message.endsWith(`status ${status}`) && !error.message.includes("private"));
  }
});

test("application secret client rejects incomplete or mismatched responses", async () => {
  const bad = [
    {},
    { clientId: "other-app", clientSecret: "synthetic", rotatedAt: "2026-01-02T03:04:05Z" },
    { clientId: "example-assistant", clientSecret: "", rotatedAt: "2026-01-02T03:04:05Z" },
    { clientId: "example-assistant", clientSecret: "synthetic", rotatedAt: "not a date" },
  ];
  for (const body of bad) {
    const client = secretClient(async () => Response.json(body));
    await assert.rejects(client.rotateSecret("example-assistant"), (error: Error) => /Invalid Hanko application secret response/.test(error.message) && !error.message.includes("synthetic"));
  }
  const client = secretClient(async () => Response.json({ clientId: "other-app", enabled: true }));
  await assert.rejects(client.getApplication("example-assistant"), /Invalid Hanko application response/);
});

test("application secret client resolves a fresh access token per call", async () => {
  let tokens = 0;
  const client = secretClient(async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer token-${tokens}`);
    return Response.json({ clientId: "example-assistant", clientSecret: "synthetic", rotatedAt: "2026-01-02T03:04:05Z" });
  }, () => `token-${++tokens}`);
  await client.rotateSecret("example-assistant");
  await client.rotateSecret("example-assistant");
  assert.equal(tokens, 2);
});
