// @vitest-environment happy-dom
// /admin «Запросы на развитие» (D73, M2-59 mvp_scope): categories by frequency, a category filters the latest
// requests, quotes render as text with links to the system and the client; «Пилот» → the D70 limit of an org and the
// founder's raise (M2-34).
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { DevelopmentRequests, Me } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const me: Me = { user: { id: "u1", email: "founder@example.ru" }, memberships: [] };
const VERIFIED = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: "2026-10-05T22:00:00Z" };

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

function app(over: Partial<ApiClient>, url: string): HTMLDivElement {
  const known: Partial<ApiClient> = {
    getMe: async () => me,
    getOrgSettings: async () => ({}) as never,
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
const all = (el: HTMLElement, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

const DATA: DevelopmentRequests = {
  categories: [
    { category: "payments", last7: 2, last30: 3, total: 4, systems: 3, lastAt: "2026-10-05T07:00:00Z" },
    { category: "domain", last7: 0, last30: 1, total: 1, systems: 1, lastAt: "2026-09-20T07:00:00Z" },
  ],
  items: [
    {
      id: "g1",
      category: "payments",
      quote: "<script>alert(1)</script> Хочу оплату картой, звоните [ТЕЛЕФОН_1]",
      offered: "Заявка с оплатой по счёту",
      createdAt: "2026-10-05T07:00:00Z",
      orgId: ORG,
      orgName: "Салон",
      systemId: SYS,
      systemName: "Запись в салон",
      email: "olga@salon.example",
    },
    {
      id: "g2",
      category: "domain",
      quote: "Хочу свой домен",
      offered: null,
      createdAt: "2026-09-20T07:00:00Z",
      orgId: ORG,
      orgName: "Салон",
      systemId: null,
      systemName: null,
      email: null,
    },
  ],
};

describe("/admin «Запросы на развитие»", () => {
  test("categories by frequency in words, latest requests with system link and address; quotes as text; filter", async () => {
    const load = vi.fn(async (category?: string) => ({
      ...DATA,
      items: DATA.items.filter((x) => !category || x.category === category),
    }));
    const el = app(
      { adminDevelopmentRequests: load as unknown as ApiClient["adminDevelopmentRequests"] },
      "/admin?tab=gaps",
    );
    await waitFor(() => all(el, "admin-gaps-category").length === 2);
    const rows = all(el, "admin-gaps-category");
    expect(rows.map((r) => r.dataset.category)).toEqual(["payments", "domain"]);
    expect(rows[0]?.textContent).toBe("Оплата2343");
    const item = all(el, "admin-gaps-item")[0] as HTMLElement;
    expect(item.textContent).toContain("olga@salon.example");
    expect(item.querySelector(`a[href="/s/${SYS}"]`)?.textContent).toBe("Запись в салон");
    expect(item.textContent).toContain("Заявка с оплатой по счёту");
    expect(q(el, "admin-gaps-quote")?.textContent).toContain("<script>alert(1)</script>");
    expect(el.querySelector("script")).toBeNull();
    expect(all(el, "admin-gaps-item")[1]?.textContent).toContain("замены не нашлось");
    await act(async () => {
      rows[1]?.querySelector("button")?.click();
    });
    expect(load).toHaveBeenLastCalledWith("domain");
    await waitFor(() => all(el, "admin-gaps-item").length === 1);
  });
});

describe("/admin «Пилот»: the D70 limit", () => {
  test("shows builds and edits used of the limit; the founder raises the builds limit", async () => {
    const usage = (builds: number) => ({
      pilot: true,
      free: true,
      builds: { limit: builds, used: 5, left: Math.max(0, builds - 5), nextAt: null },
      edits: { limit: 20, used: 2, left: 18, nextAt: null },
    });
    let builds = 5;
    const setLimits = vi.fn(async (_org: string, b: { builds?: number | null }) => {
      builds = b.builds ?? 5;
      return { orgId: ORG, builds, edits: 20, usage: usage(builds) };
    });
    const el = app(
      {
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
        adminListPilotOrgs: (async () => ({
          month: "2026-10",
          capRub: 6000,
          items: [
            {
              id: ORG,
              name: "Салон",
              plan: "pilot",
              members: 1,
              requireFounderReview: true,
              creditsAvailable: 100,
              creditsSpentMonth: 0,
              modelSpendRub: 0,
              usage: usage(builds),
            },
          ],
        })) as never,
        adminSetPilotLimits: setLimits as unknown as ApiClient["adminSetPilotLimits"],
      },
      "/admin",
    );
    await waitFor(() => q(el, "admin-tab-pilot") !== null);
    act(() => q(el, "admin-tab-pilot")?.click());
    await waitFor(() => q(el, "admin-pilot-limits-usage") !== null);
    expect(q(el, "admin-pilot-limits-usage")?.textContent).toBe("Сборки: 5 из 5 · Правки: 2 из 20");
    const input = q(el, "admin-pilot-limit-builds") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q(el, "admin-pilot-limit-save")?.click();
    });
    expect(setLimits).toHaveBeenCalledWith(ORG, { builds: 10 });
    await waitFor(
      () => q(el, "admin-pilot-limits-usage")?.textContent === "Сборки: 5 из 10 · Правки: 2 из 20",
    );
    expect(q(el, "admin-pilot-limits-note")?.textContent).toBe("Лимит сохранён");
  });
});
