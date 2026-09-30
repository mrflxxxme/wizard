// @vitest-environment happy-dom
// Client hooks against a local hono mock of the runtime API (sdk.md §3, backlog M0-07).
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildListQuery,
  matchRoute,
  SdkClient,
  SseParser,
  useEntity,
  useEntityList,
  useEntityMutation,
  useMutation,
  useParams,
  usePayment,
  useQuery,
  useUser,
  WizardError,
} from "../src/index.js";
import { createMockRuntime } from "./helpers/mock-server.js";
import { renderHook } from "./helpers/render.js";

// The SDK registry is not augmented inside the package: hooks are called with loose names here.
const q = useQuery as unknown as (name: string, args: unknown) => ReturnType<typeof useQuery>;
const m = useMutation as unknown as (
  name: string,
) => [
  (args: unknown, opts?: { consent?: true }) => Promise<unknown>,
  { pending: boolean; error?: WizardError },
];
const list = useEntityList as unknown as (entity: string, opts?: unknown) => ReturnType<typeof useEntityList>;
const one = useEntity as unknown as (entity: string, id: string | undefined) => ReturnType<typeof useEntity>;
const mut = useEntityMutation as unknown as (entity: string) => {
  create(doc: unknown, opts?: { consent?: true }): Promise<Record<string, unknown>>;
  update(id: string, patch: unknown): Promise<Record<string, unknown>>;
  remove(id: string): Promise<void>;
};
const pay = usePayment as unknown as (i: string) => {
  pay(b: string, id: string): Promise<void>;
  pending: boolean;
  error?: WizardError;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(extra: Record<string, unknown> = {}) {
  const server = createMockRuntime();
  const client = new SdkClient({ fetch: server.fetch, reconnectDelayMs: 5 });
  cleanups.push(() => client.close());
  const render = <T>(hook: () => T) => {
    const r = renderHook(hook, { client, debounceMs: 10, ...extra });
    cleanups.push(r.unmount);
    return r.result;
  };
  return { server, client, render };
}

describe("useQuery", () => {
  test("loading → data, deps drive SSE invalidation (debounced), unrelated entities ignored", async () => {
    const { server, render } = setup();
    const r = render(() => q("ticketAvailability", {}));
    expect(r.current.isLoading).toBe(true);
    await vi.waitFor(() => expect(r.current.data).toEqual([{ id: "tt1", left: 5 }]));
    expect(r.current.isLoading).toBe(false);
    const call = server.requests.find((x) => x.path === "/api/fn/ticketAvailability");
    expect(call).toMatchObject({ method: "POST", body: { args: {} }, headers: { "x-wizard-request": "1" } });

    await vi.waitFor(() => expect(server.openStreams).toBe(1));
    server.state.availabilityLeft = 4;
    await server.invalidate("stream");
    await new Promise((res) => setTimeout(res, 40));
    expect(server.state.fnCalls.ticketAvailability).toBe(1);
    // Two events in a burst → one refetch (100 ms debounce in prod, 10 ms here).
    await server.invalidate("ticket", { id: "t1", op: "insert" });
    await server.invalidate("ticket_type");
    await vi.waitFor(() => expect(r.current.data).toEqual([{ id: "tt1", left: 4 }]));
    await new Promise((res) => setTimeout(res, 40));
    expect(server.state.fnCalls.ticketAvailability).toBe(2);
  });

  test("error carries code, message and details; 'skip' sends nothing", async () => {
    const { server, render } = setup();
    const failing = render(() => q("boom", {}));
    await vi.waitFor(() => expect(failing.current.error).toBeInstanceOf(WizardError));
    expect(failing.current.error).toMatchObject({ code: "INTERNAL", status: 500 });
    const missing = render(() => q("nope", { a: 1 }));
    await vi.waitFor(() => expect(missing.current.error?.code).toBe("NOT_FOUND"));
    expect(missing.current.error?.message).toBe("Функция не найдена");
    const skipped = render(() => q("ticketAvailability", "skip"));
    await new Promise((res) => setTimeout(res, 20));
    expect(skipped.current).toMatchObject({ data: undefined, isLoading: false, error: undefined });
    expect(server.state.fnCalls.ticketAvailability).toBeUndefined();
  });

  test("refetch() and SSE reconnect → resync of active queries", async () => {
    const { server, render } = setup();
    const r = render(() => q("ticketAvailability", {}));
    await vi.waitFor(() => expect(r.current.data).toBeDefined());
    r.current.refetch();
    await vi.waitFor(() => expect(server.state.fnCalls.ticketAvailability).toBe(2));
    await vi.waitFor(() => expect(server.openStreams).toBe(1));
    server.dropStreams();
    await vi.waitFor(() => expect(server.openStreams).toBe(1));
    await vi.waitFor(() => expect(server.state.fnCalls.ticketAvailability).toBe(3));
  });
});

describe("useMutation", () => {
  test("run resolves with result; consent adds _consent from RoleSpec", async () => {
    const { server, render } = setup();
    const r = render(() => m("registerTicket"));
    const [run] = r.current;
    await expect(run({ streamId: "s1" }, { consent: true })).resolves.toEqual({
      ticketId: "t1",
      needsPayment: true,
    });
    const body = server.requests.find((x) => x.path === "/api/fn/registerTicket")?.body as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      args: { streamId: "s1" },
      _consent: { policyVersion: "pv-1", textHash: "hash-from-rolespec" },
    });
    // RoleSpec fetched once per client.
    await run({ streamId: "s1" }, { consent: true });
    expect(server.requests.filter((x) => x.path === "/_wizard/spec")).toHaveLength(1);
    await vi.waitFor(() => expect(r.current[1].pending).toBe(false));
  });

  test("run rejects with WizardError and exposes it as state", async () => {
    const { render } = setup();
    const r = render(() => m("registerTicket"));
    const err = await r.current[0]({ streamId: "full" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WizardError);
    expect(err).toMatchObject({
      code: "STREAM_FULL",
      status: 400,
      details: { message: "Мест нет", stream: "full" },
    });
    await vi.waitFor(() => expect(r.current[1].error?.code).toBe("STREAM_FULL"));
  });
});

describe("entities (data API)", () => {
  test("useEntityList builds filter/sort/page/limit and refetches on its entity", async () => {
    const { server, render } = setup();
    const r = render(() =>
      list("stream", {
        filter: { capacity: { gte: 5, in: [5, 10] }, name: "Ритейл" },
        sort: ["-created_at", "name"],
        page: 2,
        limit: 10,
      }),
    );
    await vi.waitFor(() => expect(r.current.items).toHaveLength(2));
    expect(r.current).toMatchObject({ total: 2, page: 2, hasMore: false, isLoading: false });
    const req = server.requests.find((x) => x.path === "/api/data/stream");
    expect(req?.query).toEqual({
      "filter[capacity][gte]": "5",
      "filter[capacity][in]": "5,10",
      "filter[name]": "Ритейл",
      sort: "-created_at,name",
      page: "2",
      limit: "10",
    });
    await vi.waitFor(() => expect(server.openStreams).toBe(1));
    server.state.streams.stream.push({ id: "s3", name: "Новый", capacity: 1 });
    await server.invalidate("stream", { id: "s3", op: "insert" });
    await vi.waitFor(() => expect(r.current.items).toHaveLength(3));
  });

  test("useEntity: item, 404 → null, undefined id → idle; refetch on matching id", async () => {
    const { server, render } = setup();
    const r = render(() => one("stream", "s1"));
    await vi.waitFor(() => expect(r.current.data).toMatchObject({ id: "s1", name: "Ритейл" }));
    const missing = render(() => one("stream", "zzz"));
    await vi.waitFor(() => expect(missing.current.isLoading).toBe(false));
    expect(missing.current).toMatchObject({ data: null, error: undefined });
    const idle = render(() => one("stream", undefined));
    expect(idle.current.isLoading).toBe(false);
    await vi.waitFor(() => expect(server.openStreams).toBe(1));
    (server.state.streams.stream[0] as Record<string, unknown>).name = "Ритейл 2";
    await server.invalidate("stream", { id: "s2" });
    await new Promise((res) => setTimeout(res, 40));
    expect(r.current.data).toMatchObject({ name: "Ритейл" });
    await server.invalidate("stream", { id: "s1" });
    await vi.waitFor(() => expect(r.current.data).toMatchObject({ name: "Ритейл 2" }));
  });

  test("useEntityMutation create/update/remove", async () => {
    const { server, render } = setup();
    const r = render(() => mut("stream"));
    const created = await r.current.create({ name: "Новый", capacity: 3 }, { consent: true });
    expect(created).toMatchObject({ id: "s3", name: "Новый" });
    const post = server.requests.find((x) => x.method === "POST" && x.path === "/api/data/stream");
    expect(post?.body).toEqual({
      name: "Новый",
      capacity: 3,
      _consent: { policyVersion: "pv-1", textHash: "hash-from-rolespec" },
    });
    await expect(r.current.update("s3", { capacity: 4 }, { consent: true })).resolves.toMatchObject({
      capacity: 4,
    });
    const patch = server.requests.find((x) => x.method === "PATCH");
    expect(patch?.body).toEqual({
      capacity: 4,
      _consent: { policyVersion: "pv-1", textHash: "hash-from-rolespec" },
    });
    await expect(r.current.remove("s3")).resolves.toBeUndefined();
    const err = await r.current.update("s3", { capacity: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(
      server.requests.filter((x) => x.method !== "GET").every((x) => x.headers["x-wizard-request"] === "1"),
    ).toBe(true);
  });
});

describe("auth, payments, routing", () => {
  test("useUser: me, login navigation, logout", async () => {
    const navigate = vi.fn();
    const { server, render } = setup({ navigate });
    server.state.user = { id: "u1", role: "participant", display_name: "Анна", isAdmin: false };
    const r = render(() => useUser());
    expect(r.current.isLoading).toBe(true);
    await vi.waitFor(() =>
      expect(r.current.user).toEqual({ id: "u1", role: "participant", displayName: "Анна", isAdmin: false }),
    );
    r.current.login({ role: "participant" as never, next: "/ticket/1" });
    expect(navigate).toHaveBeenCalledWith("/login?role=participant&next=%2Fticket%2F1");
    await r.current.logout();
    await vi.waitFor(() => expect(r.current.user).toBeNull());
    expect(server.requests.some((x) => x.method === "POST" && x.path === "/api/auth/logout")).toBe(true);
  });

  test("anonymous session → user null", async () => {
    const { render } = setup();
    const r = render(() => useUser());
    await vi.waitFor(() => expect(r.current.isLoading).toBe(false));
    expect(r.current.user).toBeNull();
  });

  test("usePayment posts binding and redirects to the confirmation page", async () => {
    const redirect = vi.fn();
    const { server, render } = setup({ redirect });
    const r = render(() => pay("yookassa"));
    await r.current.pay("ticket", "t1");
    expect(server.requests.find((x) => x.path === "/api/pay/yookassa")?.body).toEqual({
      binding: "ticket",
      id: "t1",
    });
    expect(redirect).toHaveBeenCalledWith("https://yoomoney.ru/checkout/test");
  });

  test("useParams matches pages[].route; static segments win", async () => {
    const { render } = setup({ routes: ["/ticket/:id", "/ticket/new", "/"], pathname: "/ticket/abc%20d" });
    const r = render(() => useParams());
    expect(r.current).toEqual({ id: "abc d" });
    expect(matchRoute("/ticket/new", "/ticket/new")).toEqual({});
    expect(matchRoute("/ticket/:id", "/ticket")).toBeNull();
  });
});

describe("provider", () => {
  test("SdkProvider builds its own client from baseUrl/fetch and closes it on unmount", async () => {
    const server = createMockRuntime();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      server.fetch(url.replace("https://sys.test", ""), init),
    );
    const r = renderHook(() => q("ticketAvailability", {}), {
      baseUrl: "https://sys.test/",
      fetch,
      debounceMs: 5,
    });
    await vi.waitFor(() => expect(r.result.current.data).toEqual([{ id: "tt1", left: 5 }]));
    expect(fetch).toHaveBeenCalledWith("https://sys.test/api/fn/ticketAvailability", expect.anything());
    await vi.waitFor(() => expect(server.openStreams).toBe(1));
    r.unmount();
    await vi.waitFor(() => expect(server.openStreams).toBe(0));
  });
});

describe("transport units", () => {
  test("consent: hash of consentText when RoleSpec has no hash; missing policyVersion → CONSENT_REQUIRED", async () => {
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("Текст")))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const bodies: unknown[] = [];
    let compliance: Record<string, unknown> = { policyVersion: "pv-2", consentText: "Текст" };
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/_wizard/spec")) return new Response(JSON.stringify({ compliance }), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ result: null, deps: [] }), { status: 200 });
    };
    await new SdkClient({ fetch, realtime: false }).callFunction("f", {}, { consent: true });
    expect(bodies[0]).toEqual({ args: {}, _consent: { policyVersion: "pv-2", textHash: hash } });
    compliance = { consentText: "Текст" };
    await expect(
      new SdkClient({ fetch, realtime: false }).callFunction("f", {}, { consent: true }),
    ).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
    const fixed = new SdkClient({ fetch, realtime: false, consent: { policyVersion: "x", textHash: "y" } });
    await fixed.callFunction("f", { a: 1 }, { consent: true });
    expect(bodies.at(-1)).toEqual({ args: { a: 1 }, _consent: { policyVersion: "x", textHash: "y" } });
  });

  test("buildListQuery", () => {
    expect(buildListQuery({})).toBe("");
    expect(
      decodeURIComponent(buildListQuery({ filter: { a: null, b: { contains: "x" } }, sort: "-a" })),
    ).toBe("?filter[a]=null&filter[b][contains]=x&sort=-a");
  });

  test("SseParser handles comments, multi-line data, CRLF and chunk boundaries", () => {
    const got: [string, string][] = [];
    const p = new SseParser((e, d) => got.push([e, d]));
    p.push(': heartbeat\n\nevent: invalidate\r\ndata: {"entity":');
    p.push('"x"}\n\ndata: a\ndata: b\n\n');
    expect(got).toEqual([
      ["invalidate", '{"entity":"x"}'],
      ["message", "a\nb"],
    ]);
  });

  test("network failure → WizardError NETWORK", async () => {
    const client = new SdkClient({ fetch: () => Promise.reject(new TypeError("down")), realtime: false });
    await expect(client.callFunction("x", {})).rejects.toMatchObject({ code: "NETWORK", status: 0 });
  });
});
