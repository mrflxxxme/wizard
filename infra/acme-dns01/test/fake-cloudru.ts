// In-memory Cloud.ru IAM + Evolution DNS (the subset of the public API the solver uses), as a fetch function.
import type { PublicRecord, PublicZone } from "../src/index.js";

export interface FakeCloudru {
  fetch: typeof fetch;
  zones: PublicZone[];
  records: Map<string, PublicRecord>;
  calls: string[];
  tokensIssued: number;
  /** Next create of this name answers 409 ALREADY_EXISTS after inserting a competing record (race). */
  raceOn?: { name: string; value: string };
  /** Operations stay pending for this many polls. */
  pendingPolls: number;
}

export function fakeCloudru(o: { zones: PublicZone[]; pageSize?: number }): FakeCloudru {
  const ops = new Map<string, { resourceId: string; polls: number }>();
  let seq = 0;
  const state: FakeCloudru = {
    fetch: undefined as unknown as typeof fetch,
    zones: o.zones,
    records: new Map(),
    calls: [],
    tokensIssued: 0,
    pendingPolls: 0,
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const op = (resourceId: string) => {
    const id = `op-${++seq}`;
    ops.set(id, { resourceId, polls: state.pendingPolls });
    return { id, resourceId, done: state.pendingPolls === 0 };
  };
  const page = <T>(items: T[], token: string | null, key: string) => {
    const size = o.pageSize ?? 100;
    const start = token ? Number(token) : 0;
    const next = start + size < items.length ? String(start + size) : "";
    return { [key]: items.slice(start, start + size), ...(next ? { nextPageToken: next } : {}) };
  };

  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${url.pathname}`);
    if (url.hostname === "iam.api.cloud.ru") {
      const b = JSON.parse(String(init?.body)) as { keyId: string; secret: string };
      if (b.keyId !== "kid" || b.secret !== "sec") return reply(401, { code: 16, message: "bad key" });
      state.tokensIssued++;
      return reply(200, {
        access_token: `tok-${state.tokensIssued}`,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer tok-")) return reply(401, { code: 16, message: "unauthenticated" });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.pathname === "/v1/publicZones" && method === "GET") {
      if (url.searchParams.get("projectId") !== "proj") return reply(200, { zones: [] });
      return reply(200, page(state.zones, url.searchParams.get("pageToken"), "zones"));
    }
    if (url.pathname === "/v1/publicRecordsSole" && method === "GET") {
      const zid = url.searchParams.get("publicZoneId");
      const rs = [...state.records.values()].filter((r) => r.publicZoneId === zid);
      return reply(200, page(rs, url.searchParams.get("pageToken"), "records"));
    }
    if (url.pathname === "/v1/publicRecordsSole" && method === "POST") {
      const name = String(body.name);
      const exists = [...state.records.values()].some(
        (r) => r.publicZoneId === body.publicZoneId && r.name === name && r.type === body.type,
      );
      if (state.raceOn && state.raceOn.name === name) {
        const id = `rec-${++seq}`;
        state.records.set(id, {
          id,
          publicZoneId: String(body.publicZoneId),
          name,
          type: "txt",
          values: [state.raceOn.value],
          ttl: 120,
        });
        state.raceOn = undefined;
        return reply(409, { code: 6, message: "already exists" });
      }
      if (exists) return reply(409, { code: 6, message: "already exists" });
      const id = `rec-${++seq}`;
      state.records.set(id, {
        id,
        publicZoneId: String(body.publicZoneId),
        name,
        type: String(body.type),
        values: body.values as string[],
        ttl: Number(body.ttl),
      });
      return reply(200, op(id));
    }
    const m = /^\/v1\/publicRecordsSole\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const rec = state.records.get(m[1] as string);
      if (!rec) return reply(400, { code: 9, message: "record not found" });
      if (method === "PATCH") {
        rec.values = body.values as string[];
        rec.ttl = Number(body.ttl);
        return reply(200, op(rec.id as string));
      }
      if (method === "DELETE") {
        state.records.delete(rec.id as string);
        return reply(200, op(rec.id as string));
      }
    }
    const om = /^\/v1\/operations\/([^/]+)$/.exec(url.pathname);
    if (om) {
      const o2 = ops.get(om[1] as string);
      if (!o2) return reply(404, { code: 5, message: "no op" });
      o2.polls = Math.max(0, o2.polls - 1);
      return reply(200, { id: om[1], resourceId: o2.resourceId, done: o2.polls === 0 });
    }
    return reply(404, { code: 5, message: "route" });
  }) as typeof fetch;
  return state;
}
