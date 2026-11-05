import assert from "node:assert/strict";
import test from "node:test";
import { HankoResponseError, requestHankoJson } from "./http.js";

test("bounds a stalled fetch even when a supplied fetch ignores cancellation", async () => {
  await assert.rejects(requestHankoJson("https://auth.example.test", {}, {
    fetch: () => new Promise<Response>(() => undefined), timeoutMs: 10,
  }), /aborted/);
});

test("bounds a response body that stalls after successful headers", async () => {
  let cancelled = false;
  await assert.rejects(requestHankoJson("https://auth.example.test", {}, {
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
    timeoutMs: 10,
  }), /aborted/);
  assert.equal(cancelled, true);
});

test("refuses oversized streamed bodies and declared lengths without parsing them", async () => {
  for (const headers of [{}, { "Content-Length": "1000" }]) {
    await assert.rejects(requestHankoJson("https://auth.example.test", {}, {
      fetch: async () => new Response(JSON.stringify({ value: "x".repeat(100) }), { headers }),
      maxResponseBytes: 32,
    }), /byte limit/);
  }
});

test("refuses redirects, invalid limits and upstream errors without exposing their body", async () => {
  await assert.rejects(requestHankoJson("https://auth.example.test", {}, {
    fetch: async () => new Response("private-token-sentinel", { status: 403 }),
  }), (error: unknown) => error instanceof Error && /status 403/.test(error.message) && !error.message.includes("sentinel"));
  await assert.rejects(requestHankoJson("https://auth.example.test", {}, {
    fetch: async () => Response.redirect("https://other.example.test"),
  }), /status 302/);
  await assert.rejects(requestHankoJson("https://auth.example.test", {}, { timeoutMs: 0 }), /limits/);
});

test("malformed response JSON is classified without exposing parser input", async () => {
  await assert.rejects(requestHankoJson("https://auth.example.test", {}, {
    fetch: async () => new Response("private-provider-packet-sentinel"),
  }), (error: unknown) => error instanceof HankoResponseError && !error.message.includes("sentinel") && error.cause === undefined);
});
