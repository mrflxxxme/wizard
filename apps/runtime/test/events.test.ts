// GET /api/events (runtime.yaml#realtime): invalidation after commit, visibility by role, id only without rowFilter,
// no field values, ≤ 3 streams per session, Origin check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceInfo } from "../src/index.js";
import { type ExecHarness, type ExecSystem, execHarness } from "./exec-helpers.js";
import { login, request, seedRow } from "./helpers.js";

let h: ExecHarness;
let sys: ExecSystem;
const cookie: Record<string, string> = {};

interface Stream {
  res: Response;
  events(): { entity: string; id?: string; op: string }[];
  text(): string;
  close(): Promise<void>;
}

async function open(role?: string, headers: Record<string, string> = {}): Promise<Stream> {
  const res = await h.rt.fetch(
    request("GET", sys.host, "/api/events", { cookie: role ? cookie[role] : undefined, headers }),
  );
  let buf = "";
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  void (async () => {
    if (!reader || res.status !== 200) return;
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) return;
      buf += dec.decode(r.value, { stream: true });
    }
  })();
  return {
    res,
    text: () => buf,
    events: () =>
      buf
        .split("\n\n")
        .filter((b) => b.startsWith("event: invalidate\n"))
        .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6))),
    close: async () => {
      await reader?.cancel().catch(() => {});
    },
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
}

beforeAll(async () => {
  h = await execHarness();
  sys = await h.fnSystem("evt");
  for (const r of ["organizer", "participant"]) cookie[r] = await login(h.rt, sys.host, r);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("/api/events", () => {
  it("ticket created by a participant: organizer gets the id, participant without id, visitor nothing", async () => {
    const org = await open("organizer");
    const part = await open("participant");
    const vis = await open();
    expect(org.res.status).toBe(200);
    expect(org.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const stream = await seedRow(h.sql, sys.schema, sys.spec, "stream", { capacity: 10 });
    const type = await seedRow(h.sql, sys.schema, sys.spec, "ticket_type", {
      kind: "standard",
      active: true,
    });
    const c = complianceInfo(sys.spec);
    const res = await h.rt.fetch(
      request("POST", sys.host, "/api/fn/registerTicket", {
        cookie: cookie.participant,
        body: {
          args: {
            ticketTypeId: type,
            streamId: stream,
            holderName: "Анна Тестова",
            holderEmail: "a@example.test",
          },
          _consent: { policyVersion: c.policyVersion, textHash: c.consentTextHash },
        },
      }),
    );
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { ticketId: string } };
    await until(() => org.events().length > 0 && part.events().length > 0);
    expect(org.events()).toContainEqual({ entity: "ticket", id: result.ticketId, op: "insert" });
    expect(part.events()).toContainEqual({ entity: "ticket", op: "insert" });
    expect(part.events().some((e) => e.id !== undefined)).toBe(false);
    expect(vis.res.status).toBe(200);
    expect(vis.events().filter((e) => e.entity === "ticket")).toEqual([]);
    expect(org.text()).not.toContain("Анна");
    await Promise.all([org.close(), part.close(), vis.close()]);
  });

  it("at most 3 streams per session; a closed stream frees its slot", async () => {
    const s = [await open("organizer"), await open("organizer"), await open("organizer")];
    expect(s.map((x) => x.res.status)).toEqual([200, 200, 200]);
    const fourth = await open("organizer");
    expect(fourth.res.status).toBe(429);
    await s[0]?.close();
    await until(() => false, 50);
    const again = await open("organizer");
    expect(again.res.status).toBe(200);
    await Promise.all([...s.slice(1), again].map((x) => x.close()));
  });

  it("a foreign Origin is rejected; X-Wizard-Request is not required", async () => {
    const bad = await open("organizer", { origin: "http://evil.localhost:4100" });
    expect(bad.res.status).toBe(403);
    const ok = await open("organizer", { origin: `http://${sys.host}` });
    expect(ok.res.status).toBe(200);
    await ok.close();
  });
});
