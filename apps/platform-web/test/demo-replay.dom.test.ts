// @vitest-environment happy-dom
// B2-02 (D76 (12)): demo replay of a staff org — S1 and the workspace show «Режим показа: ответы моделей записаны,
// расходов нет», S1 offers the recorded scenarios as briefs, /admin «Пилот» switches the mode per org and shows the
// API's refusal for a client org.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { Me, Org } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const CLIENT_ORG = "44444444-4444-4444-8444-444444444444";
const SYS = "33333333-3333-4333-8333-333333333333";
const BANNER = "Режим показа: ответы моделей записаны, расходов нет";
const BRIEF = "Организуем отраслевой форум «Северный ритейл» для сетевой розницы…";
const me: Me = {
  user: { id: "u1", email: "founder@example.ru" },
  memberships: [{ orgId: ORG, orgName: "Wizard — показ", role: "owner" }],
};
const VERIFIED = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: "2026-10-05T22:00:00Z" };
const demoOrg: Org = {
  id: ORG,
  name: "Wizard — показ",
  plan: "free",
  demoReplay: true,
  demoScenarios: [{ name: "forum", title: "Отраслевой форум «Северный ритейл»", brief: BRIEF }],
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function waitFor(cond: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

function app(over: Partial<ApiClient>, url: string, who: Me = me): HTMLDivElement {
  const known: Partial<ApiClient> = {
    getMe: async () => who,
    getOrgSettings: async () => ({}) as never,
    listSystems: async () => ({ items: [] }) as never,
    listMembers: async () => ({ items: [] }) as never,
    adminSession: (async () => VERIFIED) as unknown as ApiClient["adminSession"],
    adminListAbuseReports: async () => ({ items: [] }),
    ...over,
  };
  const api = new Proxy(known, {
    get(t, k) {
      if (k in t || typeof k !== "string" || k === "then") return Reflect.get(t, k);
      return async () => {
        throw new ApiError(404, { code: "NOT_FOUND", message_ru: "Не найдено" });
      };
    },
  });
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      h(PlatformProvider, { api: api as ApiClient } as ComponentProps<typeof PlatformProvider>, h(App)),
    ),
  );
  return container;
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("S1 in demo replay", () => {
  test("banner and the recorded scenario as a brief", async () => {
    const el = app({ getOrg: async () => demoOrg }, "/");
    await waitFor(() => q(el, "start-demo-replay") !== null);
    expect(q(el, "start-demo-replay")?.textContent).toBe(BANNER);
    act(() => q(el, "start-demo-forum")?.click());
    expect((q(el, "start-prompt") as HTMLTextAreaElement).value).toBe(BRIEF);
    expect(q(el, "start-demo-forum")?.getAttribute("aria-pressed")).toBe("true");
  });

  test("no banner and no scenarios without the mode", async () => {
    const el = app(
      { getOrg: async () => ({ id: ORG, name: "Салон", plan: "free", demoReplay: false }) },
      "/",
    );
    await waitFor(() => q(el, "start-prompt") !== null);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(q(el, "start-demo-replay")).toBeNull();
    expect(q(el, "start-demo-forum")).toBeNull();
  });
});

describe("workspace in demo replay", () => {
  test("the chat shows the banner while getSystem.demoReplay", async () => {
    const el = app(
      {
        getSystem: async () =>
          ({
            system: { id: SYS, orgId: ORG, name: "Форум", stage: "interview", draftRevision: 0 },
            messages: [],
            demoReplay: true,
          }) as never,
      },
      `/s/${SYS}`,
    );
    await waitFor(() => q(el, "workspace-demo-replay") !== null);
    expect(q(el, "workspace-demo-replay")?.textContent).toBe(BANNER);
  });
});

describe("/admin «Пилот» → «Режим показа»", () => {
  test("switches the mode of a staff org; a client org's refusal is shown", async () => {
    let on = false;
    const set = vi.fn(async (orgId: string, v: boolean) => {
      if (orgId === CLIENT_ORG)
        throw new ApiError(403, {
          code: "FORBIDDEN",
          message_ru: "Режим показа доступен только служебной организации",
        });
      on = v;
      return { orgId, kind: "staff", demoReplay: v };
    });
    const el = app(
      {
        getOrg: async (id: string) => ({ ...demoOrg, id, demoReplay: id === ORG && on }),
        adminSetOrgDemoReplay: set as unknown as ApiClient["adminSetOrgDemoReplay"],
        adminPilotReadiness: (async () => ({
          on: true,
          by: null,
          at: null,
          note: null,
          checklist: [],
        })) as never,
        adminPilotSpend: (async () => ({
          month: "2026-10",
          spentRub: 0,
          capRub: 6000,
          sharePercent: 0,
          warn: false,
          reached: false,
        })) as never,
        adminListPilotInvites: async () => ({ items: [] }),
        adminListPilotOrgs: (async () => ({ month: "2026-10", capRub: 6000, items: [] })) as never,
      },
      "/admin",
      {
        ...me,
        memberships: [...me.memberships, { orgId: CLIENT_ORG, orgName: "Салон", role: "owner" }],
      },
    );
    await waitFor(() => q(el, "admin-tab-pilot") !== null);
    act(() => q(el, "admin-tab-pilot")?.click());
    await waitFor(() => q(el, `admin-demo-replay-${ORG}`) !== null);
    const box = q(el, `admin-demo-replay-${ORG}`) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => box.click());
    expect(set).toHaveBeenCalledWith(ORG, true);
    await waitFor(() => (q(el, `admin-demo-replay-${ORG}`) as HTMLInputElement).checked);
    await act(async () => q(el, `admin-demo-replay-${CLIENT_ORG}`)?.click());
    await waitFor(() => q(el, "admin-demo-replay-error") !== null);
    expect(q(el, "admin-demo-replay-error")?.textContent).toBe(
      "Режим показа доступен только служебной организации",
    );
  });
});
