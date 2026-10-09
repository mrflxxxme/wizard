// @vitest-environment happy-dom
// V3-06 (DOM, API doubles): «Собрать» of a v3 system — the style line by the brief (not chosen, picked by the owner,
// chosen by the system), «Собрать · до 500 ₽» posts the brief version and hands the run to the canvas, a stale brief
// (412) is said in words and re-read, a viewer sees no buttons; the three directions over the canvas — the pick closes
// the drawer and the canvas re-reads the brief; «потрачено X ₽ из Y» from the harness lines.
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { act, type ComponentProps, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { ARCHETYPES } from "../../../packages/ui-kit/src/v3/design/archetypes.js";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { RunEvent } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { StyleDrawer, spentLine, V3BuildCard } from "../src/screens/v3/V3Build.js";
import type { DirectionsApi, DirectionsProposalView } from "../src/v3/directions/api.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "66666666-6666-4666-8666-666666666666";
const brief = (design: Partial<SystemBrief["design"]> = {}): SystemBrief =>
  systemBriefSchema.parse({ ...dentalBrief(), design: { references: [], ...design } });
const A = ARCHETYPES[2] as (typeof ARCHETYPES)[number];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function mount(api: Partial<ApiClient>, node: ReactNode): Promise<void> {
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
        node,
      ),
    ),
  );
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}
const $ = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const click = async (id: string) => {
  await act(async () => $(id)?.click());
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
};

const card = (over: Partial<ComponentProps<typeof V3BuildCard>> = {}) =>
  h(V3BuildCard, {
    systemId: SYS,
    version: 4,
    brief: brief(),
    editable: true,
    onStarted: () => {},
    onStyle: () => {},
    onStale: () => {},
    ...over,
  });

describe("«Собрать» of a v3 system", () => {
  test("the style line by the brief; «Собрать · до 500 ₽» posts the version and hands the run over", async () => {
    const run = { id: "r1", kind: "build", status: "queued", createdAt: "" };
    const approveBrief = vi.fn(async () => ({ run, capCredits: 100 }));
    const onStarted = vi.fn();
    const onStyle = vi.fn();
    await mount({ approveBrief } as unknown as Partial<ApiClient>, card({ onStarted, onStyle }));
    expect($("canvas-v3-style")?.textContent).toContain("ещё не выбран");
    expect($("canvas-v3-style-open")?.textContent).toBe("Выбрать стиль");
    expect($("canvas-v3-approve")?.textContent).toBe("Собрать · до 500 ₽");
    await click("canvas-v3-style-open");
    expect(onStyle).toHaveBeenCalled();
    await click("canvas-v3-approve");
    expect(approveBrief).toHaveBeenCalledWith(SYS, 4);
    expect(onStarted).toHaveBeenCalledWith(run);
  });

  test("a picked style and the system's choice in words; a viewer sees no buttons", async () => {
    await mount({}, card({ brief: brief({ archetype: A.id, pinned: true }) }));
    expect($("canvas-v3-style")?.textContent).toBe(`«${A.name}» — выбран вами`);
    expect($("canvas-v3-style-open")?.textContent).toBe("Сменить стиль");
    act(() => root?.unmount());
    await mount({}, card({ brief: brief({ archetype: A.id, pinned: false }), editable: false }));
    expect($("canvas-v3-style")?.textContent).toBe(`«${A.name}» — подберём сами`);
    expect($("canvas-v3-approve")).toBeNull();
    expect($("canvas-v3-style-open")).toBeNull();
  });

  test("a stale brief (412) is said in words and re-read; another refusal shows the server's text", async () => {
    const approveBrief = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(412, { code: "VERSION_CONFLICT", message_ru: "Бриф изменился" }))
      .mockRejectedValueOnce(
        new ApiError(409, { code: "SYSTEM_LOCKED", message_ru: "Идёт сборка — дождитесь её окончания" }),
      );
    const onStale = vi.fn();
    await mount({ approveBrief } as unknown as Partial<ApiClient>, card({ onStale }));
    await click("canvas-v3-approve");
    expect($("canvas-v3-error")?.textContent).toContain("Бриф успели изменить");
    expect(onStale).toHaveBeenCalledTimes(1);
    await click("canvas-v3-approve");
    expect($("canvas-v3-error")?.textContent).toBe("Идёт сборка — дождитесь её окончания");
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});

describe("the three directions over the canvas", () => {
  test("the pick goes to the API and the canvas closes the drawer and re-reads the brief", async () => {
    const proposal: DirectionsProposalView = {
      id: "b".repeat(64),
      briefVersion: 4,
      createdAt: "",
      costRub: 0,
      fallback: true,
      references: [],
      picked: null,
      directions: ARCHETYPES.slice(0, 3).map((a, i) => ({
        n: i + 1,
        archetype: a.id,
        name: a.name,
        why: a.why,
        texts: { title: "Запись", action: "Записаться" },
        textsSource: "brief",
        tuning: [],
        header: "simple",
        hero: "split",
        fonts: { display: "Inter", text: "Inter" },
        palette: { background: "#fff", foreground: "#111", accent: "#0f766e" },
        previewHtml: "<p>Первый экран</p>",
      })),
    };
    const pick = vi.fn(async () => ({ archetype: ARCHETYPES[1]?.id ?? "", pinned: true }));
    const directions = { get: async () => proposal, pick } as unknown as DirectionsApi;
    const onPicked = vi.fn();
    const onClose = vi.fn();
    await mount({}, h(StyleDrawer, { systemId: SYS, editable: true, onClose, onPicked, api: directions }));
    expect(container?.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Стиль сайта");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("canvas-v3-style-close");
    await click("direction-pick-2");
    expect(pick).toHaveBeenCalledWith(SYS, proposal.id, 2);
    expect(onPicked).toHaveBeenCalled();
    await click("canvas-v3-style-close");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("spend of a v3 build", () => {
  test("the latest «потрачено X ₽ из Y» of the harness lines, null before one", () => {
    const ev = (seq: number, type: string, text?: string): RunEvent => ({
      runId: "r",
      seq,
      ts: "",
      type,
      payload: text ? { text } : {},
    });
    expect(spentLine([ev(1, "run_started"), ev(2, "build_stage")])).toBeNull();
    expect(
      spentLine([
        ev(1, "agent_message", "Готово: каркас. Сейчас потрачено 12 ₽ из 500 ₽."),
        ev(2, "agent_message", "Готово: запись. Проверил в браузере. Сейчас потрачено 130,5 ₽ из 500 ₽."),
        ev(3, "agent_message", "Собираю дальше"),
      ]),
    ).toBe("потрачено 130,5 ₽ из 500 ₽");
  });
});
