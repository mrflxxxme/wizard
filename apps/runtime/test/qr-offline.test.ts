// M2-03 over HTTP and Postgres: /_wizard/qr/manifest (package without tokens and PII, gzip, delta by cursor),
// /_wizard/qr/sync (two devices with overlaps, idempotent re-send, first scan wins), PWA files of every system,
// and the implicit hiding of qr_token (connectors/qr.yaml#token.visibility, L3-30).
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AppSpec } from "@wizard/appspec";
import { parseQrPayload, qrOfflineHash, signQrToken } from "@wizard/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forumSpec, login, request, seedRow, seedUser } from "./helpers.js";
import { type PreviewFixture, previewFixture } from "./preview-helpers.js";

type Json = Record<string, unknown>;
type Ticket = { id: string; token: string; h: string };

let fx: PreviewFixture;
const systems: Record<string, { key: string; schema: string; host: string }> = {};

async function system(slug: string, spec: AppSpec = forumSpec()) {
  const entry = await fx.publish({ slug, env: "draft", revision: 1, spec, migrate: true });
  systems[slug] = {
    key: entry.systemId,
    schema: `app_${entry.systemId}_draft`,
    host: `${slug}--draft.localhost:4100`,
  };
}

async function seedTickets(
  slug: string,
  n: number,
  o: { createdAt?: Date; holder?: string } = {},
): Promise<Ticket[]> {
  const s = systems[slug];
  if (!s) throw new Error(`no system ${slug}`);
  const spec = forumSpec();
  const stream = await seedRow(fx.sql, s.schema, spec, "stream", { name: "Технологии" });
  const type = await seedRow(fx.sql, s.schema, spec, "ticket_type", { name: "VIP" });
  const holder = o.holder ?? (await seedUser(fx.sql, s.schema, "participant"));
  const rows = Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    ticket_type: type,
    stream,
    holder_user: holder,
    holder_name: "Иван Петров",
    holder_email: `holder${i}-${randomUUID().slice(0, 6)}@example.ru`,
    status: "paid",
    amount: 1500,
    event_starts_at: "2026-11-01T09:00:00.000Z",
    qr_token: signQrToken(fx.ring, { systemId: s.key, env: "draft" }),
    created_at: o.createdAt ?? new Date(),
  }));
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await fx.sql`insert into ${fx.sql(s.schema)}.${fx.sql("ticket")} ${fx.sql(chunk)}`;
  }
  return rows.map((r) => ({ id: r.id, token: r.qr_token, h: qrOfflineHash(r.qr_token) as string }));
}

const hostOf = (slug: string) => systems[slug]?.host ?? "";

async function manifest(slug: string, cookie: string | null, q = "", headers: Record<string, string> = {}) {
  return fx.rt.fetch(request("GET", hostOf(slug), `/_wizard/qr/manifest${q}`, { cookie, headers }));
}

async function sync(slug: string, cookie: string | null, body: unknown, o: { csrf?: boolean } = {}) {
  return fx.rt.fetch(request("POST", hostOf(slug), "/_wizard/qr/sync", { cookie, body, ...o }));
}

const event = (h: string, at = new Date(), gate = "Вход А") => ({
  clientEventId: randomUUID(),
  h,
  scannedAt: at.toISOString(),
  gate,
  localResult: "queued",
});

beforeAll(async () => {
  fx = await previewFixture();
  await system("qroff");
  await system("qrbig");
  const vis = forumSpec();
  vis.permissions.push({ role: "partner", entity: "ticket", ops: ["read"] });
  await system("qrvis", vis);
}, 120_000);
afterAll(() => fx?.close());

describe("GET /_wizard/qr/manifest", () => {
  test("delta by cursor: only changed carriers, new check-ins; full without a cursor", async () => {
    const cookie = await login(fx.rt, hostOf("qroff"), "volunteer");
    const old = new Date(Date.now() - 10 * 60_000);
    const [a, b, c] = await seedTickets("qroff", 3, { createdAt: old });
    if (!a || !b || !c) throw new Error("no tickets");
    const full = (await (await manifest("qroff", cookie)).json()) as Json & { entries: { id: string }[] };
    expect(full.full).toBe(true);
    expect(full.entries.map((e) => e.id)).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    const s = systems.qroff;
    await fx.sql`update ${fx.sql(s?.schema ?? "")}.${fx.sql("ticket")} set status = 'canceled' where id = ${b.id}`;
    const checked = await fx.rt.fetch(
      request("POST", hostOf("qroff"), "/_wizard/qr/check", {
        cookie,
        body: { payload: c.token, deviceId: "d" },
      }),
    );
    expect(((await checked.json()) as Json).status).toBe("ok");
    const delta = (await (
      await manifest("qroff", cookie, `?since=${encodeURIComponent(String(full.cursor))}`)
    ).json()) as Json & { entries: { id: string; h: string; s: string }[]; checkedIn: string[] };
    expect(delta.full).toBe(false);
    const ids = delta.entries.map((e) => e.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(delta.entries.find((e) => e.id === b.id)?.s).toBe("canceled");
    expect(delta.checkedIn).toContain(c.h);
    expect(delta.checkedIn).not.toContain(a.h);
  });

  test("5 000 tickets: h/id/d/s only — no token, rand or PII; gzip ≤ 600 KiB", async () => {
    const tickets = await seedTickets("qrbig", 5000);
    const cookie = await login(fx.rt, hostOf("qrbig"), "volunteer");
    const res = await manifest("qrbig", cookie, "", { "accept-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const zipped = Buffer.from(await res.arrayBuffer());
    expect(zipped.byteLength).toBeLessThanOrEqual(600 * 1024);
    const text = gunzipSync(zipped).toString("utf8");
    const m = JSON.parse(text) as Json & { entries: Json[]; expiresAt: string; generatedAt: string };
    expect(m.entries).toHaveLength(5000);
    expect(text.length / 5000).toBeLessThan(130);
    expect(Object.keys(m.entries[0] ?? {}).sort()).toEqual(["d", "h", "id", "s"]);
    expect(m.entries[0]?.d).toBe("VIP · Технологии");
    expect(Date.parse(m.expiresAt) - Date.parse(m.generatedAt)).toBe(72 * 3_600_000);
    for (const t of tickets.slice(0, 50)) {
      expect(text).not.toContain(t.token);
      expect(text).not.toContain(parseQrPayload(t.token)?.rand);
    }
    expect(text).not.toMatch(/Иван|example\.ru|amount|holder/);
    expect(new Set(m.entries.map((e) => e.h))).toEqual(new Set(tickets.map((t) => t.h)));
  });

  test("scanner roles only: participant and the public visitor → 403; organizer → 200", async () => {
    const host = hostOf("qroff");
    expect((await manifest("qroff", await login(fx.rt, host, "participant"))).status).toBe(403);
    expect((await manifest("qroff", null)).status).toBe(403);
    expect((await manifest("qroff", await login(fx.rt, host, "organizer"))).status).toBe(200);
  });
});

describe("POST /_wizard/qr/sync", () => {
  test("100 offline scans on two devices with 10 overlaps → 90 accepted, 10 duplicate; re-send changes nothing", async () => {
    const tickets = await seedTickets("qrbig", 90);
    const host = hostOf("qrbig");
    const cookie = await login(fx.rt, host, "volunteer");
    const a = tickets.slice(0, 55).map((t) => event(t.h, new Date(Date.now() - 120_000)));
    const b = tickets.slice(45).map((t) => event(t.h, new Date(Date.now() - 60_000), "Вход Б"));
    const ra = (await (await sync("qrbig", cookie, { deviceId: "dev-a", events: a })).json()) as Json;
    const rb = (await (
      await sync("qrbig", cookie, { deviceId: "dev-b", events: b, pending: 3 })
    ).json()) as Json & {
      results: { result: string }[];
    };
    expect([ra.accepted, ra.duplicate, rb.accepted, rb.duplicate]).toEqual([55, 0, 35, 10]);
    const again = (await (await sync("qrbig", cookie, { deviceId: "dev-b", events: b })).json()) as Json & {
      results: { result: string }[];
    };
    expect(again.results.map((r) => r.result)).toEqual(rb.results.map((r) => r.result));
    const s = systems.qrbig;
    const ids = tickets.map((t) => t.id);
    const checkins = await fx.sql`
      select c.ticket, c.offline, c.device_id, c.gate from ${fx.sql(s?.schema ?? "")}.${fx.sql("checkin")} as c
      where c.ticket = any(${fx.sql.array(ids)}::uuid[])`;
    expect(checkins).toHaveLength(90);
    expect(checkins.every((c) => c.offline === true)).toBe(true);
    expect(new Set(checkins.map((c) => String(c.ticket))).size).toBe(90);
    const overlap = new Set(tickets.slice(45, 55).map((t) => t.id));
    expect(checkins.filter((c) => overlap.has(String(c.ticket))).every((c) => c.device_id === "dev-a")).toBe(
      true,
    );
    const events = await fx.sql`
      select count(*)::int as n from ${fx.sql(s?.schema ?? "")}.${fx.sql("_w_qr_events")}
      where client_event_id = any(${fx.sql.array([...a, ...b].map((e) => e.clientEventId))})`;
    expect(events[0]?.n).toBe(100);
    const devices = await fx.sql`
      select device_id, user_id, pending, last_sync_at from ${fx.sql(s?.schema ?? "")}.${fx.sql("_w_qr_devices")}
      where device_id in ('dev-a', 'dev-b') order by device_id`;
    expect(devices.map((d) => d.device_id)).toEqual(["dev-a", "dev-b"]);
    expect(devices.every((d) => d.user_id !== null && d.last_sync_at !== null)).toBe(true);
    expect(devices[1]?.pending).toBe(0);
  });

  test("online check first, earlier offline scan later → duplicate, scanned_at moves to the earlier time", async () => {
    const [t] = await seedTickets("qroff", 1);
    if (!t) throw new Error("no ticket");
    const host = hostOf("qroff");
    const cookie = await login(fx.rt, host, "volunteer");
    await fx.rt.fetch(
      request("POST", host, "/_wizard/qr/check", { cookie, body: { payload: t.token, deviceId: "online" } }),
    );
    const earlier = new Date(Date.now() - 30 * 60_000);
    const res = (await (
      await sync("qroff", cookie, { deviceId: "dev-x", events: [event(t.h, earlier)] })
    ).json()) as Json & { results: Json[] };
    expect(res.duplicate).toBe(1);
    expect(res.results[0]).toMatchObject({ result: "duplicate", firstScannedAt: earlier.toISOString() });
    const rows = await fx.sql`
      select scanned_at, device_id from ${fx.sql(systems.qroff?.schema ?? "")}.${fx.sql("checkin")} where ticket = ${t.id}`;
    expect(new Date(rows[0]?.scanned_at as string).toISOString()).toBe(earlier.toISOString());
    expect(rows[0]?.device_id).toBe("online");
  });

  test("unknown hash → unknown; device clock off by > 10 min → clock_skew", async () => {
    const [t] = await seedTickets("qroff", 1);
    if (!t) throw new Error("no ticket");
    const cookie = await login(fx.rt, hostOf("qroff"), "volunteer");
    const e1 = event("A".repeat(22));
    const e2 = event(t.h);
    const res = (await (
      await sync("qroff", cookie, {
        deviceId: "dev-skew",
        events: [e1, e2],
        sentAt: new Date(Date.now() + 11 * 60_000).toISOString(),
      })
    ).json()) as Json & { results: { result: string }[] };
    expect(res.results.map((r) => r.result)).toEqual(["unknown", "accepted"]);
    const rows = await fx.sql`
      select client_event_id, clock_skew, result from ${fx.sql(systems.qroff?.schema ?? "")}.${fx.sql("_w_qr_events")}
      where device_id = 'dev-skew' order by result`;
    expect(rows.map((r) => [r.result, r.clock_skew])).toEqual([
      ["accepted", true],
      ["unknown", true],
    ]);
  });

  test("> 500 events or a malformed event → 422; participant → 403; no CSRF header → 403", async () => {
    const host = hostOf("qroff");
    const cookie = await login(fx.rt, host, "volunteer");
    const many = Array.from({ length: 501 }, () => event("A".repeat(22)));
    const big = await sync("qroff", cookie, { deviceId: "d", events: many });
    expect(big.status).toBe(422);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect((await sync("qroff", cookie, { deviceId: "d", events: [{ h: "x" }] })).status).toBe(422);
    const participant = await login(fx.rt, host, "participant");
    expect((await sync("qroff", participant, { deviceId: "d", events: [] })).status).toBe(403);
    expect((await sync("qroff", cookie, { deviceId: "d", events: [] }, { csrf: false })).status).toBe(403);
  });
});

describe("PWA of every system (runtime.yaml#static.pwa)", () => {
  test("manifest.webmanifest: name, ru, standalone, start_url /, theme accent, icon", async () => {
    const res = await fx.rt.fetch(request("GET", hostOf("qroff"), "/manifest.webmanifest"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = (await res.json()) as Json & { icons: Json[] };
    const spec = forumSpec();
    expect(m).toMatchObject({
      name: spec.app.name,
      lang: "ru",
      display: "standalone",
      start_url: "/",
      scope: "/",
      theme_color: spec.theme?.accent,
    });
    expect(String(m.short_name).length).toBeLessThanOrEqual(15);
    expect(m.icons).toContainEqual({
      src: "/_wizard/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    });
    const icon = await fx.rt.fetch(request("GET", hostOf("qroff"), "/_wizard/icon.svg"));
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain(`fill="${spec.theme?.accent}"`);
  });

  test("sw.js precaches the shell of this revision; index.html links the manifest and the registration", async () => {
    const host = hostOf("qroff");
    const sw = await fx.rt.fetch(request("GET", host, "/sw.js"));
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const body = await sw.text();
    const config = JSON.parse(/^self\.__WZ_SW = (.*);$/m.exec(body)?.[1] ?? "{}") as {
      version: string;
      precache: string[];
    };
    expect(config.version).toMatch(/^[0-9a-f]{16}$/);
    expect(config.precache).toEqual(
      expect.arrayContaining(["/", "/manifest.webmanifest", "/_wizard/pwa.js"]),
    );
    expect(config.precache.some((p) => /^\/assets\/index-[0-9a-f]{12}\.js$/.test(p))).toBe(true);
    expect(body).toContain("wz-qr");
    const page = await fx.rt.fetch(request("GET", host, "/scanner"));
    const html = await page.text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<script src="/_wizard/pwa.js" defer></script>');
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    const reg = await fx.rt.fetch(request("GET", host, "/_wizard/pwa.js"));
    expect(reg.status).toBe(200);
    expect(await reg.text()).toContain('register("/sw.js"');
  });
});

describe("qr_token visibility (connectors/qr.yaml#token.visibility, L3-30)", () => {
  test("hidden from staff without ownership; seen by the row owner and isAdmin; never filterable by them", async () => {
    const host = hostOf("qrvis");
    const s = systems.qrvis;
    const participant = await login(fx.rt, host, "participant");
    const me =
      await fx.sql`select id from ${fx.sql(s?.schema ?? "")}.${fx.sql("users")} where role = 'participant' limit 1`;
    const [mine] = await seedTickets("qrvis", 1, { holder: String(me[0]?.id) });
    await seedTickets("qrvis", 2);
    const list = async (cookie: string, q = "") => {
      const res = await fx.rt.fetch(request("GET", host, `/api/data/ticket${q}`, { cookie }));
      return { status: res.status, body: (await res.json()) as { items?: Json[] } };
    };
    const partner = await login(fx.rt, host, "partner");
    const seen = await list(partner);
    expect(seen.status).toBe(200);
    expect(seen.body.items?.length).toBeGreaterThanOrEqual(3);
    for (const item of seen.body.items ?? []) expect(Object.hasOwn(item, "qr_token")).toBe(false);
    expect(
      (await list(partner, `?filter[qr_token][eq]=${encodeURIComponent(mine?.token ?? "")}`)).status,
    ).toBe(422);
    const volunteer = await list(await login(fx.rt, host, "volunteer"));
    for (const item of volunteer.body.items ?? []) expect(Object.hasOwn(item, "qr_token")).toBe(false);
    const admin = await list(await login(fx.rt, host, "organizer"));
    expect((admin.body.items ?? []).every((i) => typeof i.qr_token === "string")).toBe(true);
    const own = await list(participant);
    expect(own.body.items?.map((i) => i.qr_token)).toEqual([mine?.token]);
    const roleSpec = (await (
      await fx.rt.fetch(request("GET", host, "/_wizard/spec", { cookie: partner }))
    ).json()) as { entities: { name: string; fields: { name: string }[] }[] };
    const ticket = roleSpec.entities.find((e) => e.name === "ticket");
    expect(ticket?.fields.map((f) => f.name)).not.toContain("qr_token");
  });
});
