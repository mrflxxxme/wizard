// @vitest-environment happy-dom
// M2-09 in the DOM with API doubles: S-welcome (pilot onboarding after the founder's invitation) explains what is
// free, the pilot limits and the review before the first publication, and starts a system from a template (S1 with
// the template preselected) or from the owner's own words; non-pilot orgs go to S1; S1 links pilot orgs back to it;
// S-billing hides «Докупить» on the pilot plan even when payments are on (billing.yaml#plans.topup.available_on).
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import type { Billing, Me, PlanId } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { matchRoute } from "../src/app/router.js";
import { ru } from "../src/i18n/ru.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const me: Me = {
  user: { id: "u1", email: "owner@coffee.example" },
  memberships: [{ orgId: ORG, orgName: "Кофейня «Зерно»", role: "owner" }],
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  window.localStorage.clear();
});

async function waitFor(cond: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

function mount(api: Partial<ApiClient>, url: string): HTMLDivElement {
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

function pilotApi(
  plan: PlanId = "pilot",
  available = 100,
  over: Partial<ApiClient> = {},
): Partial<ApiClient> {
  return {
    getMe: async () => me,
    getOrgSettings: async () => ({}),
    getOrg: async () => ({
      id: ORG,
      name: "Кофейня «Зерно»",
      plan,
      cardBound: false,
      paymentsEnabled: false,
    }),
    getCredits: async () => ({
      balance: available,
      held: 0,
      available,
      buckets: [{ source: "topup", remaining: available, expiresAt: "2027-10-01T00:00:00Z" }],
    }),
    listSystems: async () => ({ items: [] }),
    listMembers: async () => ({ items: [] }),
    ...over,
  } as Partial<ApiClient>;
}

describe("S-welcome (pilot onboarding)", () => {
  test("route /welcome", () => {
    expect(matchRoute("/welcome")).toEqual({ name: "welcome" });
    expect(matchRoute("/welcome/")).toEqual({ name: "welcome" });
  });

  test("explains the pilot in Russian: free, credits, limits, review before the first publication", async () => {
    const el = mount(pilotApi(), "/welcome");
    await waitFor(() => q(el, "welcome-title") !== null);
    expect(q(el, "welcome-title")?.textContent).toBe("Добро пожаловать в пилот Wizard");
    expect(q(el, "welcome-org")?.textContent).toBe("Ваша организация — «Кофейня «Зерно»».");
    expect(q(el, "welcome-free")?.textContent).toContain("Пилот бесплатный");
    expect(q(el, "welcome-free")?.textContent).toContain("Оплата и привязка карты не нужны");
    await waitFor(() => q(el, "welcome-credits")?.textContent?.includes("100") === true);
    expect(q(el, "welcome-credits")?.textContent).toBe(
      "Кредиты на сборку начисляет команда Wizard. Сейчас доступно: 100 кредитов.",
    );
    expect(q(el, "welcome-limits")?.textContent).toContain("До 5 опубликованных систем, до 30 черновиков");
    expect(q(el, "welcome-review")?.textContent).toContain(
      "Перед первой публикацией системы в prod её посмотрит модератор",
    );
    // Templates without the empty «Своя задача»; the own-words button.
    expect(q(el, "welcome-template-custom")).toBeNull();
    expect(q(el, "welcome-template-event_registration")?.textContent).toBe("Мероприятие и регистрация");
    expect(q(el, "welcome-start")?.textContent).toBe(ru.welcome.start);
  });

  test("a template opens S1 with it preselected; «Описать свою систему» opens an empty S1", async () => {
    const el = mount(pilotApi(), "/welcome");
    await waitFor(() => q(el, "welcome-template-made_to_order") !== null);
    act(() => q(el, "welcome-template-made_to_order")?.click());
    await waitFor(() => q(el, "start-prompt") !== null);
    expect(window.location.pathname + window.location.search).toBe("/?template=made_to_order");
    const tpl = ru.templates.find((t) => t.id === "made_to_order");
    expect((q(el, "start-prompt") as HTMLTextAreaElement).value).toBe(tpl?.prompt);
    expect(q(el, "start-template-made_to_order")?.getAttribute("aria-pressed")).toBe("true");
    // S1 of a pilot org links back to the onboarding.
    await waitFor(() => q(el, "start-pilot-about") !== null);
    act(() => q(el, "start-pilot-about")?.click());
    await waitFor(() => q(el, "welcome-start") !== null);
    act(() => q(el, "welcome-start")?.click());
    await waitFor(() => q(el, "start-prompt") !== null);
    expect(window.location.pathname).toBe("/");
    expect((q(el, "start-prompt") as HTMLTextAreaElement).value).toBe("");
  });

  test("zero credits: the founder grants them; a non-pilot org goes straight to S1 without the pilot link", async () => {
    let el = mount(pilotApi("pilot", 0), "/welcome");
    await waitFor(() => q(el, "welcome-credits") !== null);
    expect(q(el, "welcome-credits")?.textContent).toBe(ru.welcome.credits(0));
    act(() => root?.unmount());
    container?.remove();
    el = mount(pilotApi("free", 100), "/welcome");
    await waitFor(() => q(el, "start-prompt") !== null);
    expect(window.location.pathname).toBe("/");
    await waitFor(() => q(el, "start-credits")?.textContent?.includes("Free") === true);
    expect(q(el, "start-pilot-about")).toBeNull();
  });
});

describe("S-billing on the pilot plan with payments on", () => {
  test("no «Докупить» (billing.yaml#plans.topup.available_on), plan and balance visible", async () => {
    const billing: Billing = {
      plan: "pilot",
      status: "none",
      periodEnd: null,
      cancelAtPeriodEnd: false,
      nextPlan: null,
      card: null,
      cardBinding: null,
      limits: { prodSystems: 5, members: 30, monthlyCredits: 0 },
      paymentsEnabled: true,
    };
    const el = mount(
      pilotApi("pilot", 100, {
        getOrg: async () => ({ id: ORG, name: "Кофейня «Зерно»", plan: "pilot", paymentsEnabled: true }),
        getBilling: (async () => billing) as unknown as ApiClient["getBilling"],
        listLedger: (async () => ({ items: [], nextCursor: null })) as unknown as ApiClient["listLedger"],
      }),
      "/billing",
    );
    await waitFor(() => q(el, "billing-available") !== null);
    expect(q(el, "billing-plan")?.dataset.plan).toBe("pilot");
    expect(q(el, "billing-topup")).toBeNull();
    expect(q(el, "billing-topup-packs")).toBeNull();
  });
});
