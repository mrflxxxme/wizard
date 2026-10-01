// Platform side of the preview bridge (platform-screens.yaml#preview_contract.security, L3-16).
import { afterEach, describe, expect, test, vi } from "vitest";
import { type BridgeOptions, PreviewBridge, previewSrc } from "../src/preview/bridge.js";

const ORIGIN = "http://forum--draft.localhost:4100";

function setup(over: Partial<BridgeOptions> = {}) {
  const win = { postMessage: vi.fn() };
  const frame = { contentWindow: win } as unknown as HTMLIFrameElement;
  const onMessage = vi.fn();
  const bridge = new PreviewBridge({
    frame: () => frame,
    origin: () => ORIGIN,
    revision: () => 3,
    files: () => new Set(["ui/Landing.tsx", "functions/registerTicket.ts"]),
    onMessage,
    ...over,
  });
  const msg = (data: unknown, o: { origin?: string; source?: unknown } = {}) =>
    ({ origin: o.origin ?? ORIGIN, source: "source" in o ? o.source : win, data }) as unknown as MessageEvent;
  return { bridge, win, onMessage, msg };
}

const ready = {
  wz: 1,
  type: "ready",
  payload: { protocol: 1, route: "/", role: "participant", revision: 3 },
};

afterEach(() => vi.useRealTimers());

describe("accept", () => {
  test("valid ready is accepted", () => {
    const { bridge, msg } = setup();
    expect(bridge.accept(msg(ready))).toEqual({ type: "ready", payload: ready.payload });
  });

  test("foreign origin is dropped", () => {
    const { bridge, msg } = setup();
    expect(bridge.accept(msg(ready, { origin: "http://evil.localhost:4100" }))).toBeNull();
    expect(bridge.accept(msg(ready, { origin: "http://localhost:5173" }))).toBeNull();
  });

  test("foreign source (not the iframe window) is dropped", () => {
    const { bridge, msg } = setup();
    expect(bridge.accept(msg(ready, { source: {} }))).toBeNull();
    expect(bridge.accept(msg(ready, { source: null }))).toBeNull();
  });

  test("nothing is accepted before the preview URL is known", () => {
    const { bridge, msg } = setup({ origin: () => null });
    expect(bridge.accept(msg(ready))).toBeNull();
  });

  test("envelope and payload are validated by zod", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bridge, msg } = setup();
    expect(bridge.accept(msg({ ...ready, wz: 2 }))).toBeNull();
    expect(bridge.accept(msg("ready"))).toBeNull();
    expect(bridge.accept(msg({ wz: 1, type: "whatever", payload: {} }))).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(
      bridge.accept(msg({ ...ready, payload: { ...ready.payload, route: "//evil.example" } })),
    ).toBeNull();
    expect(bridge.accept(msg({ ...ready, payload: { ...ready.payload, protocol: "1" } }))).toBeNull();
    warn.mockRestore();
  });

  test("error.message ≤ 300 chars", () => {
    const { bridge, msg } = setup();
    const ok = { wz: 1, type: "error", payload: { message: "<b>x</b>".padEnd(300, ".") } };
    expect(bridge.accept(msg(ok))?.payload).toEqual(ok.payload);
    expect(bridge.accept(msg({ wz: 1, type: "error", payload: { message: "x".repeat(301) } }))).toBeNull();
    expect(bridge.accept(msg({ wz: 1, type: "error", payload: { message: 42 } }))).toBeNull();
  });

  test("ready.revision must match the expected revision", () => {
    const { bridge, msg } = setup();
    expect(bridge.accept(msg({ ...ready, payload: { ...ready.payload, revision: 2 } }))).toBeNull();
  });

  const sel = (over: Record<string, unknown> = {}) => ({
    wz: 1,
    type: "element-selected",
    payload: {
      componentName: "AppShell",
      wzId: "1a2b3c4d:0",
      file: "ui/Landing.tsx",
      line: 10,
      route: "/",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      ...over,
    },
  });

  test("element-selected of a ui/ file of the current revision is accepted", () => {
    const { bridge, msg } = setup();
    expect(bridge.accept(msg(sel()))).toEqual({ type: "element-selected", payload: sel().payload });
  });

  test("L3-16: a forged element-selected with a foreign file is dropped", () => {
    const { bridge, msg } = setup();
    // Not a file of this revision, a server function, a path escape, a non-tsx file.
    for (const file of [
      "ui/Other.tsx",
      "functions/registerTicket.ts",
      "ui/../functions/registerTicket.ts",
      "ui/Landing.ts",
      "/ui/Landing.tsx",
    ])
      expect(bridge.accept(msg(sel({ file }))), file).toBeNull();
    // The same message from a foreign origin or another window (the system code in a popup) is dropped too.
    expect(bridge.accept(msg(sel(), { origin: "http://evil.localhost:4100" }))).toBeNull();
    expect(bridge.accept(msg(sel(), { source: {} }))).toBeNull();
  });

  test("element-selected: wzId format, line ≥ 1, componentName ≤ 60, route without //", () => {
    const { bridge, msg } = setup();
    for (const over of [
      { wzId: "demo:AppShell:0" },
      { wzId: "ui/Landing.tsx:ItemCard:1" },
      { wzId: '1a2b3c4d:0"]' },
      { line: 0 },
      { line: 1.5 },
      { componentName: "x".repeat(61) },
      { componentName: "" },
      { route: "//evil.example" },
    ])
      expect(bridge.accept(msg(sel(over))), JSON.stringify(over)).toBeNull();
  });

  test("element-selected is dropped while the revision files are unknown", () => {
    const { bridge, msg } = setup({ files: () => null });
    expect(bridge.accept(msg(sel()))).toBeNull();
  });
});

describe("send", () => {
  test("posts with the exact targetOrigin, never '*'", async () => {
    const { bridge, win } = setup();
    await bridge.send({ type: "navigate", payload: { route: "/moderation" } });
    expect(win.postMessage).toHaveBeenCalledWith(
      { wz: 1, type: "navigate", id: "p1", payload: { route: "/moderation" } },
      ORIGIN,
    );
  });

  test("reply with the same id resolves; no reply in 2 s rejects (→ reload fallback)", async () => {
    vi.useFakeTimers();
    const { bridge, msg, onMessage } = setup();
    const p = bridge.send(
      { type: "apply-theme-tokens", payload: { tokens: { "--w-accent": "#0A7D3E" }, mode: "light" } },
      true,
    );
    bridge.listener(msg({ wz: 1, type: "theme-applied", id: "p1", payload: {} }));
    await expect(p).resolves.toMatchObject({ type: "theme-applied", id: "p1" });
    expect(onMessage).toHaveBeenCalledOnce();
    const late = bridge.send({ type: "apply-theme-tokens", payload: { tokens: {}, mode: "auto" } }, true);
    vi.advanceTimersByTime(2001);
    await expect(late).rejects.toThrow("timeout");
  });

  test("messages from a foreign source never resolve a pending request", async () => {
    vi.useFakeTimers();
    const { bridge, msg } = setup();
    const p = bridge.send(
      { type: "set-role", payload: { role: "organizer", url: `${ORIGIN}/_wizard/dev-login?role=organizer` } },
      true,
    );
    bridge.listener(msg({ ...ready, id: "p1" }, { source: {} }));
    vi.advanceTimersByTime(2001);
    await expect(p).rejects.toThrow("timeout");
  });
});

test("previewSrc keeps the route in next and busts the cache by revision", () => {
  const u = new URL(previewSrc(`${ORIGIN}/_wizard/dev-login?role=participant&next=/`, "/ticket/1?x=1", 4));
  expect(u.searchParams.get("next")).toBe("/ticket/1?x=1");
  expect(u.searchParams.get("wzrev")).toBe("4");
  expect(
    new URL(previewSrc(`${ORIGIN}/_wizard/dev-login?next=/`, "//evil.example", 4)).searchParams.get("next"),
  ).toBe("/");
});
