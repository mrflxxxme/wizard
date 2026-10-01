// @vitest-environment happy-dom
// M3-01 S5 «Укажи и измени» in the DOM with API doubles: «Указать на экране» → select-mode to the preview;
// element-selected passes only for a ui/ file of the shown revision from the iframe window (L3-16) → highlight and
// onSelect; Esc and select-cancelled leave the mode; the chip shows the source line and clears; the client sends target.
import { act, type ComponentProps, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type ApiClient, createApiClient } from "../src/api/client.js";
import type { Message, MessageTarget } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { ChatFeed } from "../src/screens/workspace/ChatFeed.js";
import { sourceExcerpt, TargetChip } from "../src/screens/workspace/PointTarget.js";
import { PreviewPane } from "../src/screens/workspace/PreviewPane.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://forum--draft.localhost:4100";
const FILE = "ui/Landing.tsx";
const LANDING =
  'import { AppShell } from "@wizard/ui-kit";\n\nexport default function Landing() {\n  return (\n    <AppShell>\n';

beforeAll(() => {
  // The preview host does not exist here: the iframe never navigates (its window is a double, see preview()).
  const hd = window as unknown as {
    happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } };
  };
  hd.happyDOM.settings.navigation.disableChildFrameNavigation = true;
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function mount(api: Partial<ApiClient>, node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      h(
        PlatformProvider,
        { api: { getOrgSettings: async () => ({}), ...api } as ApiClient } as ComponentProps<
          typeof PlatformProvider
        >,
        node,
      ),
    ),
  );
  return container;
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const previewApi: Partial<ApiClient> = {
  getPreviewUrl: async () => ({
    url: `${ORIGIN}/_wizard/dev-logout?next=/`,
    revision: 3,
    roles: [],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
  getRevision: async () =>
    ({
      version: 3,
      files: [
        { path: FILE, sha256: "a", size: 1 },
        { path: "functions/registerTicket.ts", sha256: "b", size: 1 },
      ],
    }) as never,
};

const selected = (over: Record<string, unknown> = {}) => ({
  wz: 1,
  type: "element-selected",
  payload: {
    componentName: "AppShell",
    wzId: "1a2b3c4d:0",
    file: FILE,
    line: 5,
    route: "/",
    rect: { x: 0, y: 0, width: 100, height: 40 },
    ...over,
  },
});

async function preview(props: Partial<ComponentProps<typeof PreviewPane>> = {}) {
  const onSelect = vi.fn<(t: MessageTarget) => void>();
  const el = mount(
    previewApi,
    h(PreviewPane, {
      systemId: SYS,
      revision: 3,
      available: true,
      theme: {},
      testData: true,
      pointable: true,
      onSelect,
      ...props,
    }),
  );
  await waitFor(() => q(el, "preview-frame") !== null);
  const frame = q(el, "preview-frame") as HTMLIFrameElement;
  // The iframe page is not loaded here: its window is a double that records what the platform posts.
  const win = { postMessage: vi.fn() };
  Object.defineProperty(frame, "contentWindow", { value: win });
  const posted = win.postMessage;
  const fromPreview = (data: unknown, o: { origin?: string; source?: unknown } = {}) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: o.origin ?? ORIGIN,
          source: ("source" in o ? o.source : win) as Window,
        }),
      );
    });
  fromPreview({ wz: 1, type: "ready", payload: { protocol: 1, route: "/", role: null, revision: 3 } });
  // Files of revision 3 are loaded for the element-selected check.
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  const sent = (type: string) =>
    posted.mock.calls
      .filter(([m]) => (m as { type: string }).type === type)
      .map(([m, o]) => [(m as { payload: unknown }).payload, o]);
  return { el, onSelect, fromPreview, sent };
}

describe("PreviewPane «Указать на экране»", () => {
  test("toggle sends select-mode with the exact origin and shows the banner; Esc leaves the mode", async () => {
    const p = await preview();
    const toggle = q(p.el, "select-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toBe("Указать на экране");
    expect(toggle.disabled).toBe(false);
    act(() => toggle.click());
    expect(p.sent("select-mode")).toEqual([[{ enabled: true }, ORIGIN]]);
    expect(q(p.el, "select-banner")?.textContent).toContain("Режим «Укажи и измени» · кликните по элементу");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(p.sent("select-mode").at(-1)).toEqual([{ enabled: false }, ORIGIN]);
    expect(q(p.el, "select-banner")).toBeNull();
  });

  test("L3-16: forged element-selected (foreign file, foreign source, foreign origin) changes nothing", async () => {
    const p = await preview();
    act(() => q(p.el, "select-toggle")?.click());
    p.fromPreview(selected({ file: "ui/Other.tsx" }));
    p.fromPreview(selected({ file: "functions/registerTicket.ts" }));
    p.fromPreview(selected(), { source: window });
    p.fromPreview(selected(), { origin: "http://evil.localhost:4100" });
    p.fromPreview(selected({ wzId: "demo:AppShell:0" }));
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(p.sent("highlight")).toEqual([]);
    expect(q(p.el, "select-banner")).not.toBeNull();
  });

  test("a valid element-selected → onSelect(target), highlight of its wzId, the mode ends", async () => {
    const p = await preview();
    act(() => q(p.el, "select-toggle")?.click());
    p.fromPreview(selected());
    expect(p.onSelect).toHaveBeenCalledWith({
      wzId: "1a2b3c4d:0",
      componentName: "AppShell",
      file: FILE,
      line: 5,
      route: "/",
    });
    expect(p.sent("highlight")).toEqual([[{ wzId: "1a2b3c4d:0" }, ORIGIN]]);
    expect(q(p.el, "select-banner")).toBeNull();
  });

  test("select-cancelled from the preview ends the mode", async () => {
    const p = await preview();
    act(() => q(p.el, "select-toggle")?.click());
    p.fromPreview({ wz: 1, type: "select-cancelled", payload: {} });
    expect(q(p.el, "select-banner")).toBeNull();
  });

  test("not pointable (run in progress, viewer) → the toggle is disabled", async () => {
    const p = await preview({ pointable: false });
    expect((q(p.el, "select-toggle") as HTMLButtonElement).disabled).toBe(true);
  });

  test("clearing the selected element removes the highlight", async () => {
    const target: MessageTarget = { wzId: "1a2b3c4d:0", componentName: "AppShell", file: FILE, line: 5 };
    const p = await preview({ selected: target });
    expect(p.sent("highlight").at(-1)).toEqual([{ wzId: "1a2b3c4d:0" }, ORIGIN]);
    act(() =>
      root?.render(
        h(
          PlatformProvider,
          { api: { getOrgSettings: async () => ({}), ...previewApi } as ApiClient } as ComponentProps<
            typeof PlatformProvider
          >,
          h(PreviewPane, {
            systemId: SYS,
            revision: 3,
            available: true,
            theme: {},
            testData: true,
            pointable: true,
            selected: null,
          }),
        ),
      ),
    );
    expect(p.sent("highlight").at(-1)).toEqual([{ wzId: null }, ORIGIN]);
  });
});

describe("chat chip and message", () => {
  const target: MessageTarget = {
    wzId: "1a2b3c4d:0",
    componentName: "AppShell",
    file: FILE,
    line: 5,
    route: "/",
  };

  test("sourceExcerpt: the line, whitespace collapsed, ≤ 120 chars", () => {
    expect(sourceExcerpt(LANDING, 5)).toBe("<AppShell>");
    expect(sourceExcerpt(LANDING, 99)).toBe("");
    expect(sourceExcerpt(`  ${"x".repeat(200)}`, 1)).toHaveLength(120);
  });

  test("chip: component, file:line, source line of the shown revision; × clears", async () => {
    const getFileText = vi.fn(async () => LANDING);
    const onClear = vi.fn();
    const el = mount(
      { getFileText } as Partial<ApiClient>,
      h(TargetChip, { systemId: SYS, revision: 3, target, onClear }),
    );
    await waitFor(() => q(el, "chat-target-excerpt") !== null);
    expect(getFileText).toHaveBeenCalledWith(SYS, FILE, 3);
    expect(q(el, "chat-target")?.textContent).toContain("Изменить: AppShell");
    expect(q(el, "chat-target-file")?.textContent).toBe("ui/Landing.tsx:5");
    expect(q(el, "chat-target-excerpt")?.textContent).toBe("<AppShell>");
    act(() => q(el, "chat-target-clear")?.click());
    expect(onClear).toHaveBeenCalledOnce();
  });

  test("the user message of a point edit shows its element as text", () => {
    const m: Message = {
      id: "1",
      seq: 1,
      role: "user",
      kind: "text",
      text: "сделай заголовок крупнее",
      payload: { target: { wzId: "1a2b3c4d:0", componentName: "<b>AppShell</b>", file: FILE, line: 5 } },
      createdAt: "2026-10-01T10:00:00.000Z",
    };
    const el = mount({}, h(ChatFeed, { messages: [m] }));
    expect(q(el, "chat-message-target")?.textContent).toBe("<b>AppShell</b> · ui/Landing.tsx");
    expect(el.querySelector("b")).toBeNull();
  });

  test("api.postMessage sends target in the body only when given", async () => {
    const bodies: unknown[] = [];
    const api = createApiClient({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ message: {}, run: {} }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await api.postMessage(SYS, "привет");
    await api.postMessage(SYS, "сделай заголовок крупнее", { target });
    expect(bodies).toEqual([{ text: "привет" }, { text: "сделай заголовок крупнее", target }]);
  });
});
