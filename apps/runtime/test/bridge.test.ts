// M0-24: /_wizard/bridge.js behaviour (platform-screens.yaml#preview_contract) against a fake window in node:vm.
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { bridgeScript } from "../src/preview/routes.js";

const PLATFORM = "http://localhost:5173";
const SELF = "http://forum--draft.localhost:4100";

type Listener = (e: unknown) => void;

function fakeWindow(o: { framed?: boolean; role?: string | null; path?: string } = {}) {
  const listeners = new Map<string, Listener[]>();
  const posted: { msg: Record<string, unknown>; target: string }[] = [];
  const store = new Map<string, string>();
  const styles = new Map<string, string>();
  const attrs = new Map<string, string>();
  const url = new URL(o.path ?? "/ticket/1?tab=a", SELF);
  const parent = {
    postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }),
  };
  const location = {
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get href() {
      return url.href;
    },
    origin: url.origin,
    replace: vi.fn(),
  };
  const win: Record<string, unknown> = {
    URL,
    location,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    document: {
      readyState: "complete",
      documentElement: {
        style: { setProperty: (k: string, v: string) => styles.set(k, v) },
        setAttribute: (k: string, v: string) => attrs.set(k, v),
      },
    },
    history: {
      pushState(_s: unknown, _t: string, to: string) {
        const next = new URL(to, url);
        url.pathname = next.pathname;
        url.search = next.search;
      },
      replaceState() {},
    },
    PopStateEvent: class {
      constructor(readonly type: string) {}
    },
    addEventListener: (type: string, fn: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    dispatchEvent: (e: { type: string }) => {
      for (const fn of listeners.get(e.type) ?? []) fn(e);
      return true;
    },
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ role: o.role === null ? null : { name: o.role ?? "participant" } }),
    })),
  };
  win.parent = o.framed === false ? win : parent;
  const emit = (type: string, e: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  const send = (data: unknown, origin = PLATFORM, source: unknown = parent) =>
    emit("message", { data, origin, source });
  return { win, posted, store, styles, attrs, location, send, emit, listeners };
}

async function boot(o?: Parameters<typeof fakeWindow>[0]) {
  const f = fakeWindow(o);
  runInNewContext(bridgeScript(PLATFORM, 7), { window: f.win });
  await vi.waitFor(() => expect(f.posted.some((p) => p.msg.type === "ready")).toBe(true));
  return f;
}

describe("bridge.js", () => {
  test("ready after load: protocol 1, route, role, revision; exact targetOrigin", async () => {
    const f = await boot({ role: "organizer" });
    expect(f.posted[0]).toEqual({
      msg: {
        wz: 1,
        type: "ready",
        payload: { protocol: 1, route: "/ticket/1?tab=a", role: "organizer", revision: 7 },
      },
      target: PLATFORM,
    });
    expect(f.posted.every((p) => p.target === PLATFORM)).toBe(true);
  });

  test("does nothing when not framed", () => {
    const f = fakeWindow({ framed: false });
    runInNewContext(bridgeScript(PLATFORM, 1), { window: f.win });
    expect(f.listeners.size).toBe(0);
    expect(f.posted).toEqual([]);
  });

  test("apply-theme-tokens: sets --w-* tokens and data-wz-mode, answers theme-applied with the same id", async () => {
    const f = await boot();
    f.send({
      wz: 1,
      type: "apply-theme-tokens",
      id: "m1",
      payload: { tokens: { "--w-accent": "#ff0000", color: "red", "--w-x": 5 }, mode: "dark" },
    });
    expect(f.styles).toEqual(new Map([["--w-accent", "#ff0000"]]));
    expect(f.attrs.get("data-wz-mode")).toBe("dark");
    expect(f.posted.at(-1)).toEqual({
      msg: { wz: 1, type: "theme-applied", id: "m1", payload: {} },
      target: PLATFORM,
    });
    expect(f.location.replace).not.toHaveBeenCalled();
  });

  test("foreign origin, foreign source, bad envelope and unknown types are ignored", async () => {
    const f = await boot();
    const before = f.posted.length;
    const msg = { wz: 1, type: "apply-theme-tokens", id: "x", payload: { tokens: { "--w-accent": "#000" } } };
    f.send(msg, "http://evil.example");
    f.send(msg, PLATFORM, { postMessage() {} });
    f.send({ ...msg, wz: 2 });
    f.send("apply-theme-tokens");
    f.send({ wz: 1, type: "toString", payload: {} });
    f.send({ wz: 1, type: "select-all", payload: { enabled: true } });
    f.send(
      { wz: 1, type: "set-role", payload: { role: "organizer", url: "/_wizard/dev-login?role=organizer" } },
      "null",
    );
    expect(f.styles.size).toBe(0);
    expect(f.posted.length).toBe(before);
    expect(f.location.replace).not.toHaveBeenCalled();
  });

  test("set-role: same-origin login url with the current route as next; ready carries the request id", async () => {
    const f = await boot();
    f.send({
      wz: 1,
      type: "set-role",
      id: "r1",
      payload: { role: "organizer", url: "/_wizard/dev-login?role=organizer&next=/" },
    });
    expect(f.location.replace).toHaveBeenCalledWith(
      "/_wizard/dev-login?role=organizer&next=%2Fticket%2F1%3Ftab%3Da",
    );
    expect(f.store.get("wz-bridge-pending")).toBe("r1");
    // After the reload the bridge boots again and answers with ready carrying id r1.
    const g = fakeWindow({ role: "organizer" });
    (g.win.sessionStorage as { setItem(k: string, v: string): void }).setItem("wz-bridge-pending", "r1");
    runInNewContext(bridgeScript(PLATFORM, 7), { window: g.win });
    await vi.waitFor(() => expect(g.posted[0]?.msg).toMatchObject({ type: "ready", id: "r1" }));
    expect(g.store.has("wz-bridge-pending")).toBe(false);
  });

  test("set-role to another origin is ignored", async () => {
    const f = await boot();
    f.send({ wz: 1, type: "set-role", payload: { role: "x", url: "https://evil.example/login" } });
    f.send({ wz: 1, type: "set-role", payload: { role: "x", url: "//evil.example/login" } });
    expect(f.location.replace).not.toHaveBeenCalled();
  });

  test("navigate pushes the route and reports route-changed; protocol-relative routes are ignored", async () => {
    const f = await boot();
    f.send({ wz: 1, type: "navigate", payload: { route: "//evil.example" } });
    f.send({ wz: 1, type: "navigate", payload: { route: "/scanner" } });
    expect(f.posted.filter((p) => p.msg.type === "route-changed").map((p) => p.msg.payload)).toEqual([
      { route: "/scanner" },
    ]);
  });

  test("runtime errors are reported as text ≤ 300 chars", async () => {
    const f = await boot();
    f.emit("error", { message: "x".repeat(500) });
    f.emit("unhandledrejection", { reason: new Error("boom") });
    const errors = f.posted
      .filter((p) => p.msg.type === "error")
      .map((p) => p.msg.payload as { message: string });
    expect(errors[0]?.message.length).toBe(300);
    expect(errors[1]?.message).toBe("boom");
  });
});
