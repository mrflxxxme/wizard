// L3-23: RPC to the runtime only with the call's capability token {systemId, env, requestId, exp}; a forged token,
// another system's token, an expired one or a stolen one replayed after its call → 403 (isolation.yaml#M2.runtime,
// escape_tests.M2 "вызов RPC с чужим systemId / подделанным токеном → 403; украденный токен … после exp → 403").
import { WizardError } from "@wizard/sdk";
import { describe, expect, it } from "vitest";
import { issueCapability, newRequestId, SandboxRpc, verifyCapability } from "../../src/index.js";
import { KEY } from "./helpers.js";

const OTHER_KEY = new Uint8Array(32).fill(9);

describe("capability tokens", () => {
  const cap = { systemId: "abcdef012345", env: "draft" as const, requestId: newRequestId(), exp: 2_000 };

  it("round-trip; tampered payload or signature, other key → signature; exp ≤ now → expired", () => {
    const t = issueCapability(KEY, cap);
    expect(verifyCapability(KEY, t, 1_999)).toEqual({ ok: true, cap });
    expect(verifyCapability(KEY, t, 2_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyCapability(OTHER_KEY, t, 0)).toEqual({ ok: false, reason: "signature" });
    const [v, body, sig] = t.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...cap, systemId: "zzzzzzzzzzzz" })).toString("base64url");
    expect(verifyCapability(KEY, `${v}.${forged}.${sig}`, 0)).toEqual({ ok: false, reason: "signature" });
    expect(verifyCapability(KEY, `${v}.${body}.${sig.slice(0, -2)}AA`, 0).ok).toBe(false);
    for (const bad of ["", "v1", "v2.a.b", `${t}.x`, "v1..", "x".repeat(600)])
      expect(verifyCapability(KEY, bad, 0).ok).toBe(false);
  });

  it("issuing needs a 256-bit key and a well-formed capability", () => {
    expect(() => issueCapability(new Uint8Array(16), cap)).toThrow();
    expect(() => issueCapability(KEY, { ...cap, systemId: "../x" })).toThrow();
    expect(() => issueCapability(KEY, { ...cap, env: "staging" as never })).toThrow();
  });
});

function harness(now = { t: 1_000_000 }) {
  const rpc = new SandboxRpc({ key: KEY, clock: () => now.t });
  const calls: unknown[][] = [];
  const logs: unknown[][] = [];
  const hostCtx = {
    db: {
      ticket: {
        list: async (...a: unknown[]) => {
          calls.push(["db.list", ...a]);
          return [{ id: "1" }];
        },
        get: async () => {
          throw new WizardError("LIMIT_EXCEEDED", { limit: "reads" });
        },
      },
    },
    systemDb: { ticket: { count: async () => 7 } },
    log: { info: (...a: unknown[]) => logs.push(a) },
  };
  const post = (
    path: string,
    token: string | null,
    body: unknown = { op: "db", target: "db", entity: "ticket", method: "list", params: [{ limit: 1 }] },
  ) =>
    rpc.fetch(
      new Request(`http://runtime${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  return { rpc, calls, logs, hostCtx, post, now };
}

describe("SandboxRpc", () => {
  it("a token of an open call reaches its ctx: ctx.db, ctx.systemDb and ctx.log", async () => {
    const h = harness();
    const call = h.rpc.open({ systemId: "sysa00000001", env: "draft", hostCtx: h.hostCtx, timeoutMs: 1000 });
    const r = await h.post("/rpc/sysa00000001/draft", call.token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, value: [{ id: "1" }] });
    expect(h.calls).toEqual([["db.list", { limit: 1 }]]);
    const s = await h.post("/rpc/sysa00000001/draft", call.token, {
      op: "db",
      target: "systemDb",
      entity: "ticket",
      method: "count",
      params: [],
    });
    expect(await s.json()).toEqual({ ok: true, value: 7 });
    await h.post("/rpc/sysa00000001/draft", call.token, {
      op: "log",
      level: "info",
      msg: "hi",
      fields: { a: 1 },
    });
    expect(h.logs).toEqual([["hi", { a: 1 }]]);
    call.close();
  });

  it("forged, missing, foreign-system and foreign-env tokens → 403", async () => {
    const h = harness();
    const a = h.rpc.open({ systemId: "sysa00000001", env: "draft", hostCtx: h.hostCtx, timeoutMs: 1000 });
    const b = h.rpc.open({ systemId: "sysb00000002", env: "draft", hostCtx: h.hostCtx, timeoutMs: 1000 });
    expect((await h.post("/rpc/sysa00000001/draft", null)).status).toBe(403);
    expect((await h.post("/rpc/sysa00000001/draft", "v1.e30.AAAA")).status).toBe(403);
    // B's valid token used for A's data → 403; A's token on the prod env of A → 403.
    expect((await h.post("/rpc/sysa00000001/draft", b.token)).status).toBe(403);
    expect((await h.post("/rpc/sysa00000001/prod", a.token)).status).toBe(403);
    // Signed by another key (another runtime / attacker) with A's own claims → 403.
    const fake = issueCapability(OTHER_KEY, {
      systemId: "sysa00000001",
      env: "draft",
      requestId: a.requestId,
      exp: h.now.t + 1000,
    });
    expect((await h.post("/rpc/sysa00000001/draft", fake)).status).toBe(403);
    // A token for a request id that was never opened (well signed, e.g. leaked key would be needed) → 403.
    const unknown = issueCapability(KEY, {
      systemId: "sysa00000001",
      env: "draft",
      requestId: newRequestId(),
      exp: h.now.t + 1000,
    });
    expect((await h.post("/rpc/sysa00000001/draft", unknown)).status).toBe(403);
    expect(h.calls).toEqual([]);
    a.close();
    b.close();
  });

  it("stolen token: after exp → 403 even while the call is open; after the call ends → 403 before exp", async () => {
    const h = harness();
    const call = h.rpc.open({ systemId: "sysa00000001", env: "draft", hostCtx: h.hostCtx, timeoutMs: 500 });
    h.now.t += 501;
    expect((await h.post("/rpc/sysa00000001/draft", call.token)).status).toBe(403);
    call.close();
    const second = h.rpc.open({
      systemId: "sysa00000001",
      env: "draft",
      hostCtx: h.hostCtx,
      timeoutMs: 60_000,
    });
    expect((await h.post("/rpc/sysa00000001/draft", second.token)).status).toBe(200);
    second.close();
    expect((await h.post("/rpc/sysa00000001/draft", second.token)).status).toBe(403);
    expect(h.rpc.size).toBe(0);
  });

  it("only POST /rpc/<systemId>/<env>; body limit; non-object JSON → 400; host errors stay fatal", async () => {
    const h = harness();
    const call = h.rpc.open({ systemId: "sysa00000001", env: "draft", hostCtx: h.hostCtx, timeoutMs: 1000 });
    expect((await h.rpc.fetch(new Request("http://runtime/rpc/sysa00000001/draft"))).status).toBe(405);
    expect((await h.post("/other", call.token)).status).toBe(404);
    expect((await h.post("/rpc/sysa00000001/draft", call.token, [1, 2])).status).toBe(400);
    const big = await h.post("/rpc/sysa00000001/draft", call.token, { op: "db", pad: "x".repeat(1_100_000) });
    expect(big.status).toBe(413);
    const forbidden = await h.post("/rpc/sysa00000001/draft", call.token, { op: "exec", cmd: "id" });
    expect(await forbidden.json()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const lim = await h.post("/rpc/sysa00000001/draft", call.token, {
      op: "db",
      target: "db",
      entity: "ticket",
      method: "get",
      params: ["x"],
    });
    expect(await lim.json()).toMatchObject({ ok: false, error: { code: "LIMIT_EXCEEDED" } });
    expect(call.fatal).toBeInstanceOf(WizardError);
    call.close();
  });
});
