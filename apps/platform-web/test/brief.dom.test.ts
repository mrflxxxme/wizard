// @vitest-environment happy-dom
// V3-06 (DOM, API doubles): the brief on the canvas — a system without a brief (v2) shows nothing; with one, the short
// brief and the panel with versions and sessions; an edit in the panel is PUT with the version it was made on and the
// new version is shown; a stale edit (412) shows the fresh brief; after a server answer in the chat the canvas calls
// reload() and the open panel re-reads the brief, its versions and sessions.
import { briefDiagrams, briefDiff, type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { act, type ComponentProps, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { BriefVersion, BriefView, SystemSession } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { useCanvasBrief } from "../src/screens/brief/CanvasBrief.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "44444444-4444-4444-8444-444444444444";
const parse = (b: unknown): SystemBrief => systemBriefSchema.parse(b);
const b1 = parse(dentalBrief());
const b2 = parse({ ...b1, audience: "Жители района" });
const b3 = parse({ ...b2, outOfScope: [] });
const ver = (
  version: number,
  brief: SystemBrief,
  prev: SystemBrief | null,
  author: "agent" | "owner",
): BriefVersion => ({
  version,
  brief,
  diff: briefDiff(prev, brief),
  author,
  createdAt: `2026-10-08T0${version}:00:00Z`,
});
const V1 = ver(1, b1, null, "agent");
const V2 = ver(2, b2, b1, "owner");
const V3 = ver(3, b3, b2, "agent");
const view = (v: BriefVersion | null): BriefView => ({
  brief: v,
  diagrams: v ? briefDiagrams(v.brief) : null,
});
const info = ({ brief: _b, ...v }: BriefVersion) => v;
const SESSIONS: SystemSession[] = [
  {
    id: "interview:x",
    kind: "interview",
    source: null,
    status: "done",
    startedAt: "2026-10-08T01:00:00Z",
    finishedAt: "2026-10-08T01:05:00Z",
    runIds: ["x"],
    briefVersions: [1],
    changes: ["Цели: добавлено «Получать записи на приём с сайта»"],
    changesTotal: 20,
    build: null,
  },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function Host(): ReactNode {
  const b = useCanvasBrief(SYS, { orgId: "00000000-0000-0000-0000-000000000001" });
  return h(
    "div",
    null,
    h("span", { "data-testid": "available" }, String(b.available)),
    b.available ? h("button", { type: "button", "data-testid": "open", onClick: () => b.show() }) : null,
    h("button", { type: "button", "data-testid": "reload", onClick: () => b.reload() }),
    b.summary,
    b.panel,
  );
}

async function mount(api: Partial<ApiClient>): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      h(
        PlatformProvider,
        { api: { getOrgSettings: async () => ({}), ...api } as ApiClient } as ComponentProps<
          typeof PlatformProvider
        >,
        h(Host),
      ),
    ),
  );
  await flush();
  return container;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}
const $ = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const click = async (id: string) => {
  const el = $(id);
  if (!el) throw new Error(`no ${id}`);
  await act(async () => el.click());
  await flush();
};

/** API double with a brief that the test moves forward. */
function briefApi(start: BriefVersion | null) {
  const state = { latest: start, history: start ? [start] : [] };
  const api = {
    getBrief: vi.fn(async () => view(state.latest)),
    listBriefVersions: vi.fn(async () => ({
      versions: [...state.history].reverse().map(info),
      nextBefore: null,
    })),
    listSessions: vi.fn(async () => ({ sessions: SESSIONS })),
    saveBrief: vi.fn(async (_id: string, body: { baseVersion: number; brief: SystemBrief }) => {
      const prev = state.latest as BriefVersion;
      const next = ver(prev.version + 1, body.brief, prev.brief, "owner");
      state.latest = next;
      state.history.push(next);
      return { ...view(next), changed: true };
    }),
  };
  return { state, api };
}

describe("brief on the canvas", () => {
  test("a system without a brief (v2) shows nothing; an API without the route too", async () => {
    await mount(briefApi(null).api);
    expect($("available")?.textContent).toBe("false");
    expect($("canvas-brief-summary")).toBeNull();
    act(() => root?.unmount());
    await mount({
      getBrief: vi.fn(async () => {
        throw new ApiError(404, { code: "NOT_FOUND", message_ru: "Не найдено" });
      }),
    });
    expect($("available")?.textContent).toBe("false");
  });

  test("short brief, the panel with versions and sessions; an edit is PUT with baseVersion and shows version 2", async () => {
    const { api, state } = briefApi(V1);
    await mount(api);
    expect($("canvas-brief-summary")?.textContent).toContain("версия 1");
    expect(api.listBriefVersions).not.toHaveBeenCalled();
    await click("p-brief-open");
    expect($("canvas-brief-panel")).not.toBeNull();
    expect(container?.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(api.listBriefVersions).toHaveBeenCalledWith(SYS);
    expect(api.listSessions).toHaveBeenCalledWith(SYS);
    await click("p-brief-tab-sessions");
    expect($("p-session")?.textContent).toContain("Интервью");
    await click("p-brief-tab-brief");
    await click("p-brief-edit-goals");
    const input = $("p-brief-edit-goals")?.querySelectorAll("input")[1] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "50 записей в месяц",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("p-brief-save");
    expect(api.saveBrief).toHaveBeenCalledTimes(1);
    const [id, body] = api.saveBrief.mock.calls[0] as [string, { baseVersion: number; brief: SystemBrief }];
    expect(id).toBe(SYS);
    expect(body.baseVersion).toBe(1);
    expect(body.brief.goals[0]?.success).toBe("50 записей в месяц");
    expect(state.latest?.version).toBe(2);
    expect($("p-brief-panel-version")?.textContent).toContain("Версия 2");
    expect($("p-brief-notice")?.textContent).toBe("Сохранено — это версия 2.");
    expect($("canvas-brief-summary")?.textContent).toContain("версия 2");
    expect(api.listBriefVersions).toHaveBeenCalledTimes(2);
    // Esc closes the panel.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect($("canvas-brief-panel")).toBeNull();
  });

  test("a stale edit (412 VERSION_CONFLICT) shows the fresh brief and says so", async () => {
    const { api, state } = briefApi(V1);
    api.saveBrief.mockImplementationOnce(async () => {
      state.latest = V2;
      state.history.push(V2);
      throw new ApiError(412, {
        code: "VERSION_CONFLICT",
        message_ru: "Бриф изменился",
        details: { version: 2 },
      });
    });
    await mount(api);
    await click("p-brief-open");
    await click("p-brief-edit-roles");
    await click("p-brief-save");
    expect($("p-brief-notice")?.textContent).toContain("Бриф успели изменить");
    expect($("p-brief-panel-version")?.textContent).toContain("Версия 2");
  });

  test("a validation error of the server is shown in the editor", async () => {
    const { api } = briefApi(V1);
    api.saveBrief.mockRejectedValueOnce(
      new ApiError(400, { code: "VALIDATION_FAILED", message_ru: "Цели, № 1: слишком длинно" }),
    );
    await mount(api);
    await click("p-brief-open");
    await click("p-brief-edit-goals");
    await click("p-brief-save");
    expect($("p-brief-editor-errors")?.textContent).toContain(
      "Не получается сохранить: Цели, № 1: слишком длинно",
    );
  });

  test("after the server answers in the chat, reload() re-reads the brief, versions and sessions of the open panel", async () => {
    const { api, state } = briefApi(V1);
    await mount(api);
    await click("p-brief-open");
    expect($("p-brief-panel-version")?.textContent).toContain("Версия 1");
    // The edit in words: the interview wrote versions 2 and 3; the canvas got chat_output / run_finished.
    state.latest = V3;
    state.history.push(V2, V3);
    await click("reload");
    expect(api.getBrief).toHaveBeenCalledTimes(2);
    expect($("p-brief-panel-version")?.textContent).toContain("Версия 3");
    expect($("p-brief-notice")?.textContent).toBe("Бриф обновлён — версия 3.");
    expect(api.listBriefVersions).toHaveBeenCalledTimes(2);
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    await click("p-brief-tab-versions");
    expect($("p-brief-version-3")?.getAttribute("aria-current")).toBe("true");
    expect($("p-brief-change")?.getAttribute("data-op")).toBe("removed");
    // Closed panel: reload() reads only the brief.
    await click("p-brief-close");
    await click("reload");
    expect(api.listBriefVersions).toHaveBeenCalledTimes(2);
  });
});
