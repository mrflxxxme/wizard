// Tiny runtime mock (runtime.yaml#data_api, #functions, #auth, #realtime) on hono, used as injected fetch.
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export function createMockRuntime() {
  const requests: MockRequest[] = [];
  const streams = new Set<{ stream: SSEStreamingApi; close: () => void }>();
  const state = {
    user: null as null | Record<string, unknown>,
    fnCalls: {} as Record<string, number>,
    streams: {
      stream: [
        { id: "s1", name: "Ритейл", capacity: 10, created_at: "2026-10-01T00:00:00.000Z" },
        { id: "s2", name: "E-com", capacity: 5, created_at: "2026-10-02T00:00:00.000Z" },
      ] as Record<string, unknown>[],
    },
    availabilityLeft: 5,
  };
  const app = new Hono();

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const text = c.req.method === "GET" ? "" : await c.req.raw.clone().text();
    requests.push({
      method: c.req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries([...c.req.raw.headers].map(([k, v]) => [k.toLowerCase(), v])),
      body: text ? JSON.parse(text) : undefined,
    });
    await next();
  });

  app.post("/api/fn/:name", async (c) => {
    const name = c.req.param("name");
    state.fnCalls[name] = (state.fnCalls[name] ?? 0) + 1;
    const body = (await c.req.json()) as { args: Record<string, unknown> };
    if (name === "ticketAvailability") {
      return c.json({
        result: [{ id: "tt1", left: state.availabilityLeft }],
        deps: ["ticket_type", "ticket"],
      });
    }
    if (name === "registerTicket") {
      if (body.args.streamId === "full") {
        return c.json(
          { error: { code: "STREAM_FULL", message: "Мест нет", details: { stream: "full" } } },
          400,
        );
      }
      return c.json({ result: { ticketId: "t1", needsPayment: true }, deps: ["ticket"] });
    }
    if (name === "boom") return c.text("oops", 500);
    return c.json({ error: { code: "NOT_FOUND", message: "Функция не найдена" } }, 404);
  });

  app.get("/api/data/:entity", (c) => {
    const items = state.streams.stream;
    return c.json({
      items,
      page: Number(c.req.query("page") ?? 1),
      limit: 20,
      total: items.length,
      hasMore: false,
    });
  });
  app.get("/api/data/:entity/:id", (c) => {
    const item = state.streams.stream.find((s) => s.id === c.req.param("id"));
    return item
      ? c.json({ item })
      : c.json({ error: { code: "NOT_FOUND", message: "Запись не найдена" } }, 404);
  });
  app.post("/api/data/:entity", async (c) => {
    const doc = (await c.req.json()) as Record<string, unknown>;
    const item = {
      ...doc,
      id: `s${state.streams.stream.length + 1}`,
      created_at: "2026-10-03T00:00:00.000Z",
    };
    delete (item as { _consent?: unknown })._consent;
    state.streams.stream.push(item);
    return c.json({ item }, 201);
  });
  app.patch("/api/data/:entity/:id", async (c) => {
    const { _consent, ...patch } = (await c.req.json()) as Record<string, unknown>;
    void _consent;
    const item = state.streams.stream.find((s) => s.id === c.req.param("id"));
    if (!item) return c.json({ error: { code: "NOT_FOUND", message: "Запись не найдена" } }, 404);
    Object.assign(item, patch);
    return c.json({ item });
  });
  app.delete("/api/data/:entity/:id", (c) => {
    state.streams.stream = state.streams.stream.filter((s) => s.id !== c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/auth/me", (c) =>
    state.user
      ? c.json({ user: state.user })
      : c.json({ error: { code: "UNAUTHENTICATED", message: "Войдите в систему" } }, 401),
  );
  app.post("/api/auth/logout", (c) => {
    state.user = null;
    return c.body(null, 204);
  });
  app.post("/api/pay/:integration", (c) => c.json({ confirmationUrl: "https://yoomoney.ru/checkout/test" }));
  app.get("/_wizard/spec", (c) =>
    c.json({
      compliance: {
        consentText: "Согласен",
        policyPage: "/privacy",
        policyVersion: "pv-1",
        consentTextHash: "hash-from-rolespec",
      },
    }),
  );

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const entry = { stream, close: resolve };
        streams.add(entry);
        stream.onAbort(() => {
          streams.delete(entry);
          resolve();
        });
      });
    }),
  );

  return {
    app,
    requests,
    state,
    fetch: (input: string, init?: RequestInit) => Promise.resolve(app.request(input, init)),
    get openStreams() {
      return streams.size;
    },
    async invalidate(entity: string, extra: Record<string, unknown> = {}) {
      for (const { stream } of streams) {
        await stream.writeSSE({
          event: "invalidate",
          data: JSON.stringify({ entity, op: "update", ...extra }),
        });
      }
    },
    /** Server-side disconnect of every SSE stream (client should reconnect and resync). */
    dropStreams() {
      for (const s of [...streams]) {
        streams.delete(s);
        s.close();
      }
    },
  };
}
