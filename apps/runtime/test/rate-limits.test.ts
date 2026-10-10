// runtime.yaml#rate_limits (V3-18): /api/data 300/min per user, 60/min anonymous; /api/fn and /api/pay* 120/min per
// user, 30/min anonymous (per client network, IPv6 by /64); over the limit — 429 RATE_LIMITED + Retry-After before
// the route runs; other networks, users and systems keep working; the next minute opens a new window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rememberClientIp } from "../src/auth/client-ip.js";
import { PUBLIC_API_LIMITS, publicApiBucket } from "../src/http/rate-limits.js";
import { forumSpec, type Harness, harness, login, request } from "./helpers.js";

const A = "rla--draft.localhost:4100";
const B = "rlb--draft.localhost:4100";
let h: Harness;
let now = new Date("2026-10-09T10:00:05Z");
let organizer = "";

const anon = (host: string, method: string, path: string, ip: string | null, body?: unknown) => {
  const req = request(method, host, path, body === undefined ? {} : { body });
  if (ip) rememberClientIp(req, ip);
  return h.rt.fetch(req);
};

async function burst(n: number, call: () => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await call()).status);
  return out;
}

beforeAll(async () => {
  h = await harness({}, { clock: () => now });
  await h.system("rla", forumSpec());
  await h.system("rlb", forumSpec());
  organizer = await login(h.rt, A, "organizer");
});

afterAll(async () => {
  await h?.close();
});

describe("public API rate limits", () => {
  it("buckets: /api/data, /api/fn, /api/pay*; other /api paths are not counted here", () => {
    expect(publicApiBucket("/api/data/ticket")).toBe("data");
    expect(publicApiBucket("/api/fn/shopPlaceOrder")).toBe("fn");
    expect(publicApiBucket("/api/pay/shop/check")).toBe("pay");
    expect(publicApiBucket("/api/pay")).toBe("pay");
    expect(publicApiBucket("/api/payments")).toBeNull();
    expect(publicApiBucket("/api/ai/x")).toBeNull();
    expect(publicApiBucket("/api/v1/data/x")).toBeNull();
  });

  it("anonymous /api/data: 60 per minute per network → 429 with Retry-After and a Russian message", async () => {
    const statuses = await burst(PUBLIC_API_LIMITS.data.anonymous, () =>
      anon(A, "GET", "/api/data/session", "198.51.100.1"),
    );
    expect(statuses).not.toContain(429);
    const last = await anon(A, "GET", "/api/data/session", "198.51.100.1");
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBe(55);
    expect(((await last.json()) as { error: { code: string; message: string } }).error).toEqual(
      expect.objectContaining({
        code: "RATE_LIMITED",
        message: "Слишком много запросов — подождите минуту и попробуйте снова",
      }),
    );
    // Another network, another system and a signed-in user are not in this bucket.
    expect((await anon(A, "GET", "/api/data/session", "198.51.100.2")).status).not.toBe(429);
    expect((await anon(B, "GET", "/api/data/session", "198.51.100.1")).status).not.toBe(429);
    expect((await h.rt.fetch(request("GET", A, "/api/data/session", { cookie: organizer }))).status).toBe(
      200,
    );
    // The next minute opens a new window.
    now = new Date(now.getTime() + 60_000);
    expect((await anon(A, "GET", "/api/data/session", "198.51.100.1")).status).not.toBe(429);
  });

  it("anonymous /api/fn and /api/pay: 30 per minute; IPv6 counts by /64", async () => {
    const fn = (ip: string) => anon(A, "POST", "/api/fn/shopPlaceOrder", ip, { args: {} });
    const first = await burst(PUBLIC_API_LIMITS.functions.anonymous, () => fn("2001:db8:1:2::1"));
    expect(first).not.toContain(429);
    // Same /64, another address → the same bucket.
    expect((await fn("2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await fn("2001:db8:1:3::1")).status).not.toBe(429);
    const pay = () => anon(A, "POST", "/api/pay/shop", "203.0.113.5", { binding: "x", id: "y" });
    expect(await burst(PUBLIC_API_LIMITS.functions.anonymous, pay)).not.toContain(429);
    const over = await anon(A, "POST", "/api/pay/shop/check", "203.0.113.5", { binding: "x", id: "y" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();
  });

  it("a signed-in user: 300 data calls per minute", async () => {
    now = new Date(now.getTime() + 60_000);
    const call = () => h.rt.fetch(request("GET", A, "/api/data/session", { cookie: organizer }));
    expect(await burst(PUBLIC_API_LIMITS.data.session, call)).not.toContain(429);
    expect((await call()).status).toBe(429);
  });

  it("unknown client address (in-process call): anonymous calls are not counted", async () => {
    now = new Date(now.getTime() + 60_000);
    const statuses = await burst(PUBLIC_API_LIMITS.data.anonymous + 5, () =>
      anon(A, "GET", "/api/data/session", null),
    );
    expect(statuses).not.toContain(429);
  });
});
