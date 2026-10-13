// V4-15: instant edits in /_wizard/bridge.js — edit-mode finds the text or photo under the pointer by its source
// literal (data-wz-src of free TSX, else the page literals of /_wizard/source-map.json by value) and posts only refs,
// never the element's text; highlight-literal outlines every element of the refs; the system's own click handlers do
// not fire in edit mode; Esc cancels. Against a happy-dom document.
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bridgeScript } from "../src/preview/routes.js";

const PLATFORM = "http://localhost:5173";
const SELF = "http://clinic--draft.localhost:4100";
const PHOTO = "/_wizard/photos/00000000-0000-4000-8000-000000000000/1600";
const SOURCE_MAP = {
  "aaaaaaaa:10": { kind: "text", value: "Лечим зубы без боли", file: "ui/pages/site/Home.tsx" },
  "aaaaaaaa:50": { kind: "image", value: PHOTO, file: "ui/pages/site/Home.tsx" },
  "aaaaaaaa:90": { kind: "text", value: "Оставить заявку", file: "ui/pages/site/Home.tsx" },
  "aaaaaaaa:95": { kind: "text", value: "Оставить заявку", file: "ui/pages/site/Home.tsx" },
  // The brand repeated by the hero heading and the footer: one value, three sections.
  "cccccccc:5": { kind: "text", value: "Клиника в Казани", file: "ui/pages/site/Home.tsx", wz: "cccccccc:1" },
  "cccccccc:40": {
    kind: "text",
    value: "Клиника в Казани",
    file: "ui/pages/site/Home.tsx",
    wz: "cccccccc:2",
  },
  "cccccccc:80": {
    kind: "text",
    value: "Клиника в Казани",
    file: "ui/pages/site/Home.tsx",
    wz: "cccccccc:4",
  },
  // Two equal labels of one section: told apart by their order.
  "cccccccc:300": { kind: "text", value: "Подробнее", file: "ui/pages/site/Home.tsx", wz: "cccccccc:5" },
  "cccccccc:200": { kind: "text", value: "Подробнее", file: "ui/pages/site/Home.tsx", wz: "cccccccc:5" },
};

type Posted = { msg: Record<string, unknown>; target: string };
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
    json: async () => (url === "/_wizard/source-map.json" ? SOURCE_MAP : { role: { name: "guest" } }),
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
  const send = (type: string, payload: unknown) => {
    for (const fn of onMessage) fn({ data: { wz: 1, type, payload }, origin: PLATFORM, source: parent });
  };
  return { posted, send };
}

const sent = (p: Posted[], type: string) => p.filter((x) => x.msg.type === type).map((x) => x.msg.payload);
const byId = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const click = (id: string) =>
  byId(id).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 10));

let systemClicks = 0;
beforeEach(() => {
  window = new Window({ url: `${SELF}/` });
  document = window.document;
  systemClicks = 0;
  document.body.innerHTML = `
    <section><h1 id="title" class="hero"><span id="inner">Лечим зубы без боли</span></h1>
      <img id="photo" src="${PHOTO}" alt="">
      <a id="cta" href="#form">Оставить заявку</a></section>
    <p id="free" data-wz-src="bbbbbbbb:7 bbbbbbbb:20">Свободный TSX</p>
    <p id="plain">Текст из данных</p>
    <header data-wz-component="Header" data-wz-id="cccccccc:1"><a id="brand" href="/">Клиника в Казани</a></header>
    <section data-wz-component="Hero" data-wz-id="cccccccc:2">
      <div data-wz-component="Button" data-wz-id="dddddddd:3"><h1 id="hero-title">Клиника в Казани</h1></div></section>
    <footer data-wz-component="Footer" data-wz-id="cccccccc:9"><p id="footer-brand">Клиника в Казани</p></footer>
    <section data-wz-component="Services" data-wz-id="cccccccc:5">
      <a id="more-1" href="#a">Подробнее</a><a id="more-2" href="#b">Подробнее</a></section>`;
  byId("cta").addEventListener("click", () => systemClicks++);
});
afterEach(async () => {
  await window.happyDOM.close();
});

describe("V4-15: edit-mode of the preview bridge", () => {
  test("a click posts the literal's refs and kind, never the text; the system's click does not fire", async () => {
    const { posted, send } = boot();
    send("edit-mode", { enabled: true });
    await flush();
    click("inner");
    click("photo");
    click("cta");
    click("free");
    click("plain");
    const got = sent(posted, "literal-selected") as { refs: string[]; kind: string; ambiguous?: boolean }[];
    expect(got.map((g) => `${g.kind} ${g.refs.join(",")}${g.ambiguous ? " ambiguous" : ""}`)).toEqual([
      "text aaaaaaaa:10",
      "image aaaaaaaa:50",
      "text aaaaaaaa:90,aaaaaaaa:95 ambiguous",
      "text bbbbbbbb:7,bbbbbbbb:20",
    ]);
    expect(JSON.stringify(posted)).not.toContain("Лечим");
    expect(systemClicks).toBe(0);
    for (const p of posted) expect(p.target).toBe(PLATFORM);
  });

  test("a repeated value: the literal of the section shown (data-wz-id), then by order in its file", async () => {
    const { posted, send } = boot();
    send("edit-mode", { enabled: true });
    await flush();
    click("hero-title");
    click("brand");
    click("more-2");
    click("more-1");
    click("footer-brand");
    const got = sent(posted, "literal-selected") as { refs: string[]; ambiguous?: boolean }[];
    expect(got.map((g) => `${g.refs.join(",")}${g.ambiguous ? " ambiguous" : ""}`)).toEqual([
      "cccccccc:40",
      "cccccccc:5",
      "cccccccc:300",
      "cccccccc:200",
      "cccccccc:80",
    ]);
  });

  test("Esc cancels; off — clicks reach the system; highlight-literal outlines the elements of the refs", async () => {
    const { posted, send } = boot();
    send("edit-mode", { enabled: true });
    await flush();
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(sent(posted, "select-cancelled")).toHaveLength(1);
    click("cta");
    expect(systemClicks).toBe(1);
    expect(sent(posted, "literal-selected")).toHaveLength(0);

    send("highlight-literal", { refs: ["aaaaaaaa:95", "nonsense"] });
    await flush();
    expect(document.querySelectorAll('[data-wz-overlay="selected"]')).toHaveLength(1);
    send("highlight-literal", { refs: null });
    await flush();
    expect(document.querySelectorAll('[data-wz-overlay="selected"]')).toHaveLength(0);
  });

  test("apply-theme-tokens takes the v3 design variables (--ds-*) of the sliders' preview", () => {
    const { send } = boot();
    send("apply-theme-tokens", {
      tokens: { "--ds-radius-md": "0px", "--evil": "x", "--ds-color-muted": "oklch(0.3 0 0)" },
    });
    const st = document.documentElement.style;
    expect(st.getPropertyValue("--ds-radius-md")).toBe("0px");
    expect(st.getPropertyValue("--ds-color-muted")).toBe("oklch(0.3 0 0)");
    expect(st.getPropertyValue("--evil")).toBe("");
  });
});
