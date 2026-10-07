// @vitest-environment happy-dom
// B2-26 module factory in the DOM with API doubles: /admin «Кандидаты в модули» — the rating with week/all-time
// counts, systems and clients, the status filter, «Пересчитать сейчас», the candidate card with quotes as text,
// «Одобрить в работу» / «Выключить» / «Модуль готов» (a catalog module and a second press required, then the letters
// report); «Запросы на развитие» marks covered requests «сделано»; S-billing — the consent to «Теперь умеем» letters.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { Me, ModuleCandidate, ModuleCandidateCard, ModuleCandidates } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const C1 = "44444444-4444-4444-8444-444444444444";
const C2 = "55555555-5555-4555-8555-555555555555";
const me: Me = {
  user: { id: "u1", email: "founder@example.ru" },
  memberships: [{ orgId: ORG, orgName: "Born to Build", role: "owner" }],
};
const VERIFIED = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: "2026-10-12T22:00:00Z" };
const AT = "2026-10-12T06:17:00Z";

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
const click = async (el: HTMLElement | null) =>
  act(async () => {
    el?.click();
  });

const candidate = (over: Partial<ModuleCandidate>): ModuleCandidate => ({
  id: C1,
  key: "subscriptions:абоне занят",
  category: "subscriptions",
  title: "Абонементы на занятия",
  status: "new",
  moduleId: null,
  moduleName: null,
  rank: 1,
  weekRequests: 3,
  weekCustom: 0,
  totalRequests: 4,
  totalCustom: 0,
  systems: 4,
  clients: 3,
  examples: [
    { quote: "<b>Хочу</b> продавать абонементы", source: "request" },
    { quote: "Абонементы на занятия", source: "request" },
  ],
  lastSeenAt: AT,
  computedAt: AT,
  note: null,
  decidedAt: null,
  readyAt: null,
  suggested: { id: "packages", name: "Абонементы и пакеты", status: "ready" },
  ...over,
});

const MODULES: ModuleCandidates["modules"] = [
  {
    id: "packages",
    name: "Абонементы и пакеты",
    summary: "Продажа пакетов",
    status: "ready",
    available: true,
  },
  { id: "online_pay", name: "Онлайн-оплата", summary: "Оплата картой", status: "draft", available: false },
];

function list(items: ModuleCandidate[]): ModuleCandidates {
  return { computedAt: AT, items, modules: MODULES };
}

function cardOf(c: ModuleCandidate): ModuleCandidateCard {
  return {
    candidate: c,
    notified: c.status === "ready" ? 2 : 0,
    requests: [
      {
        id: "r1",
        quote: "Хочу продавать абонементы на занятия",
        status: c.status === "ready" ? "done" : "open",
        createdAt: AT,
        doneAt: c.status === "ready" ? AT : null,
        systemId: SYS,
        systemName: "Студия йоги",
      },
    ],
  };
}

describe("/admin «Кандидаты в модули»", () => {
  test("rating: place, wording, week and all time, systems and clients; filter and recompute", async () => {
    const load = vi.fn(async (status?: string) =>
      status === "disabled"
        ? list([
            candidate({ id: C2, title: "SMS-рассылка", category: "messaging", status: "disabled", rank: 2 }),
          ])
        : list([
            candidate({}),
            candidate({
              id: C2,
              key: "other:калик стоим",
              category: "other",
              title: "Калькулятор стоимости",
              rank: 2,
              weekRequests: 1,
              weekCustom: 2,
              totalRequests: 1,
              totalCustom: 2,
              systems: 3,
              clients: 3,
              status: "approved",
              moduleId: null,
              suggested: null,
            }),
          ]),
    );
    const recompute = vi.fn(async () => ({ computedAt: AT, candidates: 2, sent: 0 }));
    const el = app(
      {
        adminModuleCandidates: load as unknown as ApiClient["adminModuleCandidates"],
        adminRecomputeModuleCandidates: recompute,
      },
      "/admin?tab=candidates",
    );
    await waitFor(() => all(el, "admin-candidate-row").length === 2);
    expect(load).toHaveBeenLastCalledWith("open");
    const rows = all(el, "admin-candidate-row");
    expect(rows.map((r) => r.dataset.status)).toEqual(["new", "approved"]);
    const cells = (r: HTMLElement) => [...r.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells(rows[0] as HTMLElement)).toEqual([
      "1",
      "Абонементы на занятия",
      "Подписки и платный доступ",
      "3",
      "4",
      "4",
      "3",
      "новый",
    ]);
    expect(cells(rows[1] as HTMLElement)[3]).toBe("3 (дописано: 2)");
    expect(cells(rows[1] as HTMLElement)[7]).toBe("в работе");
    expect(q(el, "admin-candidates-computed")?.textContent).toContain("Рейтинг пересчитан");
    await click(q(el, "admin-candidates-recompute"));
    await waitFor(() => q(el, "admin-candidates-notice") !== null);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(q(el, "admin-candidates-notice")?.textContent).toBe("Пересчитано: 2 кандидата");
    const select = q(el, "admin-candidates-filter") as HTMLSelectElement;
    await act(async () => {
      select.value = "disabled";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => all(el, "admin-candidate-row").length === 1);
    expect(load).toHaveBeenLastCalledWith("disabled");
    expect(all(el, "admin-candidate-row")[0]?.dataset.status).toBe("disabled");
  });

  test("card: quotes as text; approve and disable; «Модуль готов» needs a module and a second press", async () => {
    let current = candidate({});
    const decide = vi.fn(async (_id: string, body: { action: string; moduleId?: string; note?: string }) => {
      current = candidate({
        status: body.action === "approve" ? "approved" : body.action === "disable" ? "disabled" : "ready",
        moduleId: body.moduleId ?? null,
        moduleName: body.moduleId === "packages" ? "Абонементы и пакеты" : null,
        note: body.note ?? null,
      });
      return {
        candidate: current,
        announced: body.action === "ready" ? { done: 4, sent: 2, noConsent: 1, failed: 0 } : null,
      };
    });
    const el = app(
      {
        adminModuleCandidates: async () => list([current]),
        adminModuleCandidate: async () => cardOf(current),
        adminDecideModuleCandidate: decide as unknown as ApiClient["adminDecideModuleCandidate"],
      },
      "/admin?tab=candidates",
    );
    await waitFor(() => q(el, "admin-candidate-open") !== null);
    await click(q(el, "admin-candidate-open"));
    await waitFor(() => q(el, "admin-candidate-card") !== null);
    expect(q(el, "admin-candidate-title")?.textContent).toBe("Абонементы на занятия");
    expect(all(el, "admin-candidate-example")[0]?.textContent).toContain("<b>Хочу</b>");
    expect(el.querySelector("[data-testid=admin-candidate-example] b")).toBeNull();
    expect(q(el, "admin-candidate-suggested")?.textContent).toBe("Похоже на модуль «Абонементы и пакеты»");
    expect(q(el, "admin-candidate-request")?.querySelector(`a[href="/s/${SYS}"]`)?.textContent).toBe(
      "Студия йоги",
    );
    const options = [...(q(el, "admin-candidate-module") as HTMLSelectElement).options].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Не выбран", "Абонементы и пакеты — готов", "Онлайн-оплата — скоро"]);

    await click(q(el, "admin-candidate-approve"));
    await waitFor(() => q(el, "admin-candidate-card")?.dataset.status === "approved");
    expect(decide).toHaveBeenLastCalledWith(C1, { action: "approve", note: "" });
    expect(q(el, "admin-candidate-approve")).toBeNull();

    // «Модуль готов» without a module: a hint, no request.
    await click(q(el, "admin-candidate-ready"));
    expect(q(el, "admin-candidate-error")?.textContent).toBe(
      "Выберите модуль каталога, который закрывает этот запрос.",
    );
    expect(decide).toHaveBeenCalledTimes(1);
    const sel = q(el, "admin-candidate-module") as HTMLSelectElement;
    await act(async () => {
      sel.value = "packages";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(q(el, "admin-candidate-ready"));
    expect(q(el, "admin-candidate-ready-confirm")?.textContent).toContain("Теперь умеем");
    expect(decide).toHaveBeenCalledTimes(1);
    await click(q(el, "admin-candidate-ready"));
    await waitFor(() => q(el, "admin-candidate-card")?.dataset.status === "ready");
    expect(decide).toHaveBeenLastCalledWith(C1, { action: "ready", moduleId: "packages", note: "" });
    expect(q(el, "admin-candidate-notice")?.textContent).toBe(
      "Готово. Запросов закрыто: 4. Писем отправлено: 2. Без согласия на письма: 1 — им не пишем.",
    );
    // Final: no more decisions, the requests are «сделано».
    expect(q(el, "admin-candidate-ready")).toBeNull();
    expect(q(el, "admin-candidate-final")?.textContent).toContain("Письмо «Теперь умеем» получили: 2");
    expect(q(el, "admin-candidate-request")?.dataset.status).toBe("done");
    await click(q(el, "admin-candidate-back"));
    await waitFor(() => q(el, "admin-candidates") !== null);
  });

  test("disable from the card; an API refusal is shown in Russian", async () => {
    let current = candidate({ status: "approved" });
    const decide = vi.fn(async (_id: string, body: { action: string }) => {
      if (body.action === "ready")
        throw new ApiError(400, {
          code: "VALIDATION_FAILED",
          message_ru: "Модуль «Онлайн-оплата» ещё не готов",
        });
      current = candidate({ status: "disabled" });
      return { candidate: current, announced: null };
    });
    const el = app(
      {
        adminModuleCandidates: async () => list([current]),
        adminModuleCandidate: async () => cardOf(current),
        adminDecideModuleCandidate: decide as unknown as ApiClient["adminDecideModuleCandidate"],
      },
      "/admin?tab=candidates",
    );
    await waitFor(() => q(el, "admin-candidate-open") !== null);
    await click(q(el, "admin-candidate-open"));
    await waitFor(() => q(el, "admin-candidate-card") !== null);
    const sel = q(el, "admin-candidate-module") as HTMLSelectElement;
    await act(async () => {
      sel.value = "online_pay";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(q(el, "admin-candidate-ready"));
    await click(q(el, "admin-candidate-ready"));
    await waitFor(() => q(el, "admin-candidate-error") !== null);
    expect(q(el, "admin-candidate-error")?.textContent).toBe("Модуль «Онлайн-оплата» ещё не готов");
    await click(q(el, "admin-candidate-disable"));
    await waitFor(() => q(el, "admin-candidate-card")?.dataset.status === "disabled");
    expect(q(el, "admin-candidate-notice")?.textContent).toBe("Сохранено");
  });

  test("«Запросы на развитие»: a request covered by a ready module is «сделано»", async () => {
    const el = app(
      {
        adminDevelopmentRequests: async () => ({
          categories: [{ category: "subscriptions", last7: 1, last30: 1, total: 1, systems: 1, lastAt: AT }],
          items: [
            {
              id: "g1",
              category: "subscriptions",
              quote: "Абонементы на занятия",
              offered: null,
              createdAt: AT,
              orgId: ORG,
              orgName: "Студия",
              systemId: SYS,
              systemName: "Студия йоги",
              email: null,
              status: "done",
              doneAt: AT,
              candidateId: C1,
            },
          ],
        }),
      },
      "/admin?tab=gaps",
    );
    await waitFor(() => q(el, "admin-gaps-item") !== null);
    expect(q(el, "admin-gaps-item")?.dataset.status).toBe("done");
    expect(q(el, "admin-gaps-done")?.textContent).toBe("сделано");
  });
});

describe("S-billing: letters about new abilities", () => {
  test("off by default; the client turns them on", async () => {
    const set = vi.fn(async (on: boolean) => ({ on, since: on ? AT : null }));
    const el = app(
      {
        getUpdatesConsent: async () => ({ on: false, since: null }),
        setUpdatesConsent: set,
      },
      "/billing",
    );
    await waitFor(() => q(el, "billing-updates-consent") !== null);
    const box = q(el, "billing-updates-consent") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(q(el, "billing-updates")?.textContent).toContain("Письма о новых возможностях");
    await click(box);
    await waitFor(() => q(el, "billing-updates-saved") !== null);
    expect(set).toHaveBeenCalledWith(true);
    expect((q(el, "billing-updates-consent") as HTMLInputElement).checked).toBe(true);
  });

  test("the block hides itself when the API does not answer", async () => {
    const el = app({}, "/billing");
    await waitFor(() => q(el, "platform-top") !== null);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(q(el, "billing-updates")).toBeNull();
  });
});
