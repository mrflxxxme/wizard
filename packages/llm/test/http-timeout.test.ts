// Model calls must not break at undici's default 300 s header timeout (D67 eval 06.10.2026): llmFetch waits as long
// as its agent allows; the route's timeout_ms stays the limit through the AbortSignal.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LLM_HTTP_TIMEOUT_MS, llmFetch } from "../src/providers.js";

describe("llmFetch: header timeout of the model calls", () => {
  const server = createServer((_req, res) => {
    // Headers only after 2.5 s — a slow non-streaming answer in miniature (undici timers tick about once a second).
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 2500);
  });
  let url = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test("the default waits far longer than undici's 300 s", () => {
    expect(LLM_HTTP_TIMEOUT_MS).toBeGreaterThan(480_000);
  });

  test("an answer within the agent timeout arrives; a shorter agent timeout breaks", async () => {
    const r = await llmFetch(10_000)(url);
    expect(await r.json()).toEqual({ ok: true });
    await expect(llmFetch(100)(url)).rejects.toThrow();
  });

  test("the AbortSignal (route timeout_ms) still ends the call", async () => {
    await expect(llmFetch()(url, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  });
});
