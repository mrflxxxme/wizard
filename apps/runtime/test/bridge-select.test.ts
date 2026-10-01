// M3-01: «Укажи и измени» in /_wizard/bridge.js (platform-screens.yaml#preview_contract.to_preview.select-mode,
// highlight; from_preview.element-selected, select-cancelled) against a happy-dom document.
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bridgeScript } from "../src/preview/routes.js";

const PLATFORM = "http://localhost:5173";
const SELF = "http://forum--draft.localhost:4100";
const WZ_MAP = {
  "1a2b3c4d:0": { file: "ui/Landing.tsx", line: 14, componentName: "AppShell" },
  "1a2b3c4d:3": { file: "ui/Landing.tsx", line: 31, componentName: "Button" },
};

type Posted = { msg: Record<string, unknown>; target: string };

// A fresh happy-dom window per test (not the vitest environment: routes.ts reads the bridge source by a file: URL).
let window: Window;
let document: Window["document"];

function boot() {
  const posted: Posted[] = [];
  const onMessage: ((e: unknown) => void)[] = [];
  const parent = {
    postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }),
  };
  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url === "/_wizard/wz-map.json" ? WZ_MAP : { role: { name: "visitor" } }),
  }));
  const win = new Proxy(window, {
    get(t, k) {
      if (k === "parent") return parent;
      if (k === "fetch") return fetch;
      if (k === "addEventListener")
        return (type: string, fn: (e: unknown) => void, capture?: boolean) =>
          type === "message"
            ? onMessage.push(fn)
            : t.addEventListener(type, fn as Parameters<typeof t.addEventListener>[1], capture);
      const v = Reflect.get(t, k);
      return typeof v === "function" && !/^[A-Z]/.test(String(k)) ? v.bind(t) : v;
    },
  });
  runInNewContext(bridgeScript(PLATFORM, 5), { window: win });
  const send = (type: string, payload: unknown, origin = PLATFORM, source: unknown = parent) => {
    for (const fn of onMessage) fn({ data: { wz: 1, type, payload }, origin, source });
  };
  return { posted, send, fetch };
}

const sent = (p: Posted[], type: string) => p.filter((x) => x.msg.type === type).map((x) => x.msg.payload);
const overlays = (kind: string) => document.querySelectorAll(`[data-wz-overlay="${kind}"]`);
const mouse = (type: string) => new window.MouseEvent(type, { bubbles: true, cancelable: true });
const byId = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const click = (id: string) => byId(id).dispatchEvent(mouse("click"));

let systemClicks = 0;
beforeEach(() => {
  window = new Window({ url: `${SELF}/` });
  document = window.document;
  systemClicks = 0;
  document.body.innerHTML = `
    <div data-wz-component="AppShell" data-wz-id="1a2b3c4d:0" data-testid="wz-appshell">
      <header><a id="brand" href="/">Форум «Северный ритейл»</a></header>
      <div data-wz-component="Badge" data-wz-id="demo:Badge:0"><span id="demo">демо</span></div>
      <div data-wz-component="Button" data-wz-id="1a2b3c4d:3"><button id="buy" type="button">Купить</button></div>
      <div data-wz-component="Button" data-wz-id="1a2b3c4d:3"><button id="buy2" type="button">Купить</button></div>
      <div data-wz-component="Button" data-wz-id="ffffffff:9"><button id="unmapped" type="button">?</button></div>
    </div>
    <p id="outside">вне компонентов</p>`;
  byId("buy").addEventListener("click", () => systemClicks++);
});
afterEach(async () => {
  await window.happyDOM.close();
});

describe("bridge.js select-mode", () => {
  test("hover outlines the nearest [data-wz-component] with a plugin wzId; overlay never takes pointer events", async () => {
    const b = boot();
    b.send("select-mode", { enabled: true });
    byId("buy").dispatchEvent(mouse("mousemove"));
    const [box] = overlays("hover");
    expect(box).toBeDefined();
    expect((box as unknown as { style: { pointerEvents: string } }).style.pointerEvents).toBe("none");
    expect(box?.textContent).toBe("Button");
    // demo:* ids (no plugin) are skipped in favour of the nearest real component.
    byId("demo").dispatchEvent(mouse("mousemove"));
    expect(overlays("hover")[0]?.textContent).toBe("AppShell");
    byId("outside").dispatchEvent(mouse("mousemove"));
    expect((overlays("hover")[0] as unknown as { style: { display: string } }).style.display).toBe("none");
  });

  test("click is swallowed (capture + preventDefault) and answers element-selected from wz-map.json", async () => {
    const b = boot();
    b.send("select-mode", { enabled: true });
    const ev = mouse("click");
    byId("brand").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(sent(b.posted, "element-selected")).toHaveLength(1));
    expect(sent(b.posted, "element-selected")[0]).toEqual({
      componentName: "AppShell",
      wzId: "1a2b3c4d:0",
      file: "ui/Landing.tsx",
      line: 14,
      route: "/",
      rect: expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) }),
    });
    expect(b.posted.every((p) => p.target === PLATFORM)).toBe(true);
    // One selection per mode: the next click reaches the system again.
    click("buy");
    expect(systemClicks).toBe(1);
    expect(sent(b.posted, "element-selected")).toHaveLength(1);
  });

  test("the system's own click handler does not run while selecting; the payload carries no element text", async () => {
    const b = boot();
    b.send("select-mode", { enabled: true });
    click("buy");
    await vi.waitFor(() => expect(sent(b.posted, "element-selected")).toHaveLength(1));
    expect(systemClicks).toBe(0);
    expect(JSON.stringify(b.posted)).not.toContain("Купить");
  });

  test("a component missing from wz-map.json is not selectable", async () => {
    const b = boot();
    b.send("select-mode", { enabled: true });
    click("unmapped");
    await new Promise((r) => setTimeout(r, 20));
    expect(sent(b.posted, "element-selected")).toEqual([]);
  });

  test("Esc → select-cancelled; select-mode false leaves without a message", async () => {
    const b = boot();
    b.send("select-mode", { enabled: true });
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(sent(b.posted, "select-cancelled")).toEqual([{}]);
    b.send("select-mode", { enabled: true });
    b.send("select-mode", { enabled: false });
    click("buy");
    expect(systemClicks).toBe(1);
    expect(sent(b.posted, "element-selected")).toEqual([]);
  });

  test("select-mode from a foreign origin or source is ignored", () => {
    const b = boot();
    b.send("select-mode", { enabled: true }, "http://evil.example");
    b.send("select-mode", { enabled: true }, PLATFORM, {});
    click("buy");
    expect(systemClicks).toBe(1);
  });
});

describe("bridge.js highlight", () => {
  test("outlines every instance with the wzId; null clears; malformed ids are ignored", () => {
    const b = boot();
    b.send("highlight", { wzId: "1a2b3c4d:3" });
    expect(overlays("selected")).toHaveLength(2);
    b.send("highlight", { wzId: '"],*,[x="' });
    expect(overlays("selected")).toHaveLength(0);
    b.send("highlight", { wzId: "1a2b3c4d:0" });
    expect(overlays("selected")).toHaveLength(1);
    b.send("highlight", { wzId: null });
    expect(overlays("selected")).toHaveLength(0);
  });
});
