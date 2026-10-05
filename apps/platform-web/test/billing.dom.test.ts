// @vitest-environment happy-dom
// M2-11 in the DOM with API doubles: S-billing (plan, balance rounded to 0.1, ledger, «Докупить» by the bound card and
// through the YooKassa page, «Привязать карту РФ» → confirmationUrl only for http(s), the return page polling a
// pending binding to CARD_NOT_RU, subscription change/cancel, editor/viewer without money buttons), S6 card status
// and blocker links, S10 «Выгрузить данные» (personal data only after a confirmation) and the consent text.
import { type RoleSpec, WzProvider } from "@wizard/ui-kit";
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import type { Billing, Me, OrgRole } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { externalNavigation, goExternal } from "../src/app/router.js";
import { ru } from "../src/i18n/ru.js";
import { PublishCard, publishBlockers } from "../src/screens/workspace/GateReport.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const me = (role: OrgRole): Me => ({
  user: { id: "u1", email: "anna@example.test" },
  memberships: [{ orgId: ORG, orgName: "Северный ритейл", role }],
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
const assign = vi.fn();
const realAssign = externalNavigation.assign;
beforeEach(() => {
  assign.mockReset();
  externalNavigation.assign = assign;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  window.localStorage.clear();
  externalNavigation.assign = realAssign;
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
const all = (el: HTMLElement, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: HTMLElement | null) => act(() => el?.click());
const btn = (el: HTMLElement, id: string) => q(el, id) as HTMLButtonElement;

const FREE: Billing = {
  plan: "free",
  status: "none",
  periodEnd: null,
  cancelAtPeriodEnd: false,
  nextPlan: null,
  card: null,
  cardBinding: null,
  limits: { prodSystems: 1, members: 3, monthlyCredits: 25 },
};
const BOUND: Billing = {
  ...FREE,
  card: { last4: "4444", issuerCountry: "RU", boundAt: "2026-10-01T09:00:00Z", cardType: "MasterCard" },
  cardBinding: { status: "bound", code: null, message_ru: null },
};

function billingApi(role: OrgRole, billing: Billing | (() => Billing), over: Partial<ApiClient> = {}) {
  const getBilling = vi.fn(async () => (typeof billing === "function" ? billing() : billing));
  const api: Partial<ApiClient> = {
    getMe: async () => me(role),
    getOrgSettings: async () => ({}),
    getOrg: async () => ({ id: ORG, name: "Северный ритейл", plan: "free", cardBound: false }),
    getCredits: async () => ({
      balance: 112.4567,
      held: 0,
      available: 112.4567,
      buckets: [
        { source: "free_welcome", remaining: 52.4567, expiresAt: "2026-10-31T00:00:00Z" },
        { source: "topup", remaining: 60, expiresAt: "2027-10-01T00:00:00Z" },
      ],
    }),
    listLedger: async () => ({
      items: [
        {
          id: "3",
          kind: "grant",
          amount: 60,
          source: "topup",
          note_ru: "Докупка",
          createdAt: "2026-10-01T09:00:00Z",
        },
        {
          id: "2",
          kind: "charge",
          amount: -7.5433,
          source: "free_welcome",
          runId: "r1",
          systemId: SYS,
          note_ru: "Сборка",
          createdAt: "2026-10-01T08:00:00Z",
        },
      ],
      nextCursor: null,
    }),
    getBilling: getBilling as unknown as ApiClient["getBilling"],
    ...over,
  };
  return { api, getBilling };
}

describe("S-billing", () => {
  test("owner: plan with limits and login methods, balance to 0.1, buckets with expiry, ledger by runs", async () => {
    const { api } = billingApi("owner", FREE);
    const el = mount(api, "/billing");
    await waitFor(() => all(el, "billing-ledger-row").length === 2);
    expect(q(el, "billing-plan")?.dataset.plan).toBe("free");
    expect(q(el, "billing-plan")?.textContent).toContain("До 1 опубликованной системы · до 3 участников");
    expect(q(el, "billing-plan")?.textContent).toContain("телефон — на тарифах Старт и Бизнес");
    expect(q(el, "billing-available")?.textContent).toBe("Доступно: 112,5 кредита");
    expect(all(el, "billing-bucket").map((b) => b.dataset.source)).toEqual(["free_welcome", "topup"]);
    expect(all(el, "billing-bucket")[1]?.textContent).toContain("докупленные: 60 · сгорят 1 октября 2027");
    const [grant, charge] = all(el, "billing-ledger-row");
    expect(grant?.textContent).toContain("+60");
    expect(charge?.textContent).toContain("−7,5");
    expect(charge?.textContent).toContain("списание");
    expect(q(el, "billing-card-status")?.textContent).toBe(ru.billing.cardNone);
    expect(btn(el, "billing-topup").textContent).toBe("Докупить 60 кредитов за 990 ₽");
  });

  test("«Докупить» by the bound card: credits at once and a notice; without a card → the YooKassa page", async () => {
    const createTopup = vi.fn(
      async (
        _org: string,
        _packs: number,
      ): Promise<{ confirmationUrl: string | null; paymentId: string }> => ({
        confirmationUrl: null,
        paymentId: "p1",
      }),
    );
    const { api } = billingApi("owner", BOUND, {
      createTopup: createTopup as unknown as ApiClient["createTopup"],
    });
    const el = mount(api, "/billing");
    await waitFor(() => q(el, "billing-card-status")?.dataset.status === "bound");
    expect(q(el, "billing-card-status")?.textContent).toBe(`${ru.billing.cardBound} · MasterCard •• 4444`);
    act(() => {
      const sel = q(el, "billing-topup-packs") as HTMLSelectElement;
      sel.value = "2";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(btn(el, "billing-topup").textContent?.replace(/\s/g, " ")).toBe(
      "Докупить 120 кредитов за 1 980 ₽",
    );
    click(q(el, "billing-topup"));
    await waitFor(() => q(el, "billing-notice") !== null);
    expect(createTopup).toHaveBeenCalledWith(ORG, 2);
    expect(q(el, "billing-notice")?.textContent).toBe("Начислено 120 кредитов");
    expect(assign).not.toHaveBeenCalled();

    createTopup.mockResolvedValueOnce({
      confirmationUrl: "https://yoomoney.ru/checkout/payments/p2",
      paymentId: "p2",
    });
    act(() => {
      const sel = q(el, "billing-topup-packs") as HTMLSelectElement;
      sel.value = "1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(q(el, "billing-topup"));
    await waitFor(() => assign.mock.calls.length === 1);
    expect(assign).toHaveBeenCalledWith("https://yoomoney.ru/checkout/payments/p2");
  });

  test("«Привязать карту РФ» → confirmationUrl; a non-http(s) URL is never navigated to", async () => {
    const start = vi.fn(async () => ({ confirmationUrl: "https://yoomoney.ru/checkout/payments/b1" }));
    const { api } = billingApi("owner", FREE, {
      startCardBinding: start as unknown as ApiClient["startCardBinding"],
    });
    const el = mount(api, "/billing");
    await waitFor(() => q(el, "billing-card-bind") !== null && !btn(el, "billing-card-bind").disabled);
    click(q(el, "billing-card-bind"));
    await waitFor(() => assign.mock.calls.length === 1);
    expect(start).toHaveBeenCalledWith(ORG);
    expect(assign).toHaveBeenCalledWith("https://yoomoney.ru/checkout/payments/b1");

    start.mockResolvedValueOnce({ confirmationUrl: "javascript:alert(1)" });
    click(q(el, "billing-card-bind"));
    await waitFor(() => q(el, "billing-error") !== null);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(goExternal("data:text/html,x")).toBe(false);
  });

  test("return from YooKassa: a pending binding is polled to CARD_NOT_RU, then ?payment= is dropped", async () => {
    let calls = 0;
    const { api, getBilling } = billingApi("owner", () => {
      calls++;
      // The page load and the first poll see «pending»; the second poll — the rejection.
      return calls < 3
        ? { ...FREE, cardBinding: { status: "pending", code: null, message_ru: null } }
        : {
            ...FREE,
            cardBinding: {
              status: "rejected",
              code: "CARD_NOT_RU",
              message_ru: "Нужна карта российского банка",
            },
          };
    });
    const el = mount(api, "/billing?payment=p1");
    await waitFor(() => q(el, "billing-checking") !== null);
    await waitFor(() => q(el, "billing-card-error") !== null, 400);
    expect(q(el, "billing-card-error")?.textContent).toBe("Нужна карта российского банка");
    expect(q(el, "billing-card-status")?.dataset.status).toBe("none");
    await waitFor(() => q(el, "billing-checking") === null);
    expect(window.location.search).toBe("");
    expect(getBilling.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("plan change by the bound card; cancel asks first and keeps the plan to the period end", async () => {
    const active: Billing = {
      ...BOUND,
      plan: "start",
      status: "active",
      periodEnd: "2026-11-01T00:00:00Z",
      limits: { prodSystems: 2, members: 10, monthlyCredits: 50 },
    };
    const change = vi.fn(
      async () =>
        ({ ...BOUND, plan: "business", status: "active", periodEnd: "2026-11-01T00:00:00Z" }) as Billing,
    );
    const cancel = vi.fn(async () => ({ ...active, cancelAtPeriodEnd: true }));
    const { api } = billingApi("owner", active, {
      changeSubscription: change as unknown as ApiClient["changeSubscription"],
      cancelSubscription: cancel as unknown as ApiClient["cancelSubscription"],
    });
    const el = mount(api, "/billing");
    await waitFor(() => q(el, "billing-plan")?.dataset.plan === "start");
    expect(q(el, "billing-plan-status")?.textContent).toContain("оплачен до 1 ноября 2026");

    click(q(el, "billing-cancel"));
    expect(q(el, "billing-cancel-confirm")?.textContent).toContain("тариф действует до 1 ноября 2026");
    click(q(el, "billing-cancel-no"));
    expect(cancel).not.toHaveBeenCalled();
    click(q(el, "billing-cancel"));
    click(q(el, "billing-cancel-yes"));
    await waitFor(() => q(el, "billing-notice") !== null);
    expect(cancel).toHaveBeenCalledWith(ORG);
    expect(q(el, "billing-plan-status")?.textContent).toContain("автопродление выключено");

    click(q(el, "billing-change-plan"));
    // The current plan with autopay off offers to resume; another plan — to switch.
    expect(q(el, "billing-plan-start-submit")?.textContent).toBe(ru.billing.resume);
    click(q(el, "billing-plan-business-submit"));
    await waitFor(() => q(el, "billing-notice")?.textContent === "Тариф «Бизнес» оформлен");
    expect(change).toHaveBeenCalledWith(ORG, "business");
    expect(q(el, "billing-plan")?.dataset.plan).toBe("business");
  });

  test("editor sees the plan and the balance without money buttons; billing is not requested", async () => {
    const { api, getBilling } = billingApi("editor", FREE, {
      getOrg: async () => ({ id: ORG, name: "Северный ритейл", plan: "start", cardBound: true }),
    });
    const el = mount(api, "/billing");
    await waitFor(
      () => q(el, "billing-available") !== null && q(el, "billing-plan")?.dataset.plan === "start",
    );
    expect(getBilling).not.toHaveBeenCalled();
    expect(q(el, "billing-change-plan")).toBeNull();
    expect(btn(el, "billing-topup").disabled).toBe(true);
    expect(btn(el, "billing-card-bind").disabled).toBe(true);
    expect(q(el, "billing-card-status")?.textContent).toBe(ru.billing.cardBound);
    expect(el.textContent).toContain(ru.billing.ownerOnly);
  });
});

describe("S-billing with WIZARD_PAYMENTS=off (M2-15, pilot)", () => {
  const PILOT: Billing = {
    ...FREE,
    plan: "pilot",
    limits: { prodSystems: 5, members: 30, monthlyCredits: 0 },
    paymentsEnabled: false,
  };
  const pilotOrg = async () => ({
    id: ORG,
    name: "Кофейня «Зерно»",
    plan: "pilot" as const,
    cardBound: false,
    paymentsEnabled: false,
  });
  const pilotCredits = async () => ({
    balance: 120,
    held: 0,
    available: 120,
    buckets: [{ source: "topup", remaining: 120, expiresAt: "2027-10-01T00:00:00Z" }],
  });

  const pilotUsage = async () => ({
    pilot: true,
    free: true,
    builds: { limit: 5, used: 5, left: 0, nextAt: "2026-11-06T09:00:00Z" },
    edits: { limit: 20, used: 5, left: 15, nextAt: null },
  });

  test("owner (D70): «На пилоте бесплатно», what is left in words and «Написать команде»; no credits, ledger, purchase or card", async () => {
    const createTopup = vi.fn();
    const start = vi.fn();
    const { api } = billingApi("owner", PILOT, {
      getOrg: pilotOrg,
      getCredits: pilotCredits,
      getUsage: pilotUsage as unknown as ApiClient["getUsage"],
      createTopup: createTopup as unknown as ApiClient["createTopup"],
      startCardBinding: start as unknown as ApiClient["startCardBinding"],
    });
    const el = mount(api, "/billing");
    await waitFor(() => q(el, "billing-payments-off") !== null && q(el, "billing-usage") !== null);
    expect(q(el, "billing-payments-off")?.textContent).toBe(ru.billing.paymentsOff);
    const plan = q(el, "billing-plan");
    expect(plan?.dataset.plan).toBe("pilot");
    expect(plan?.textContent).toContain("Пилот");
    expect(plan?.textContent).toContain("До 5 опубликованных систем · до 30 участников");
    expect(q(el, "usage-free")?.textContent).toBe("На пилоте бесплатно");
    expect(q(el, "usage-left")?.textContent).toBe("сборки закончились · ещё 15 правок");
    expect(q(el, "usage-next")?.textContent).toBe("Следующая освободится 6 ноября.");
    expect(q(el, "billing-team")?.textContent).toBe("Написать команде");
    for (const id of [
      "billing-balance",
      "billing-available",
      "billing-ledger",
      "billing-change-plan",
      "billing-cancel",
      "billing-plans",
      "billing-card",
      "billing-card-bind",
      "billing-card-status",
      "billing-topup",
      "billing-topup-packs",
    ])
      expect(q(el, id), id).toBeNull();
    expect(el.textContent).not.toMatch(/кредит|Докуп|Привязать карту/i);
    expect(createTopup).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("viewer: the same page without the owner hint; money controls never flash before GET org answers", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { api, getBilling } = billingApi("viewer", PILOT, {
      getOrg: async () => {
        await gate;
        return pilotOrg();
      },
      getCredits: pilotCredits,
      getUsage: pilotUsage as unknown as ApiClient["getUsage"],
    });
    const el = mount(api, "/billing");
    await waitFor(() => q(el, "billing-usage") !== null);
    // GET org still pending: neither the payment controls, the credits nor the notice yet.
    expect(q(el, "billing-topup")).toBeNull();
    expect(q(el, "billing-card")).toBeNull();
    expect(q(el, "billing-available")).toBeNull();
    expect(q(el, "billing-payments-off")).toBeNull();
    act(() => release?.());
    await waitFor(() => q(el, "billing-payments-off") !== null);
    expect(q(el, "billing-topup")).toBeNull();
    expect(q(el, "billing-card")).toBeNull();
    expect(q(el, "billing-available")).toBeNull();
    expect(el.textContent).not.toContain(ru.billing.ownerOnly);
    expect(getBilling).not.toHaveBeenCalled();
  });

  test("payments on (default, Org without the flag): the M2-11 controls and no payments-off notice", async () => {
    const { api } = billingApi("owner", FREE);
    const el = mount(api, "/billing");
    await waitFor(() => q(el, "billing-topup") !== null && q(el, "billing-card-bind") !== null);
    expect(q(el, "billing-payments-off")).toBeNull();
    expect(q(el, "billing-change-plan")).not.toBeNull();
  });
});

describe("S-auth: the pilot invitation link fills in the e-mail (M2-15)", () => {
  test("/login?email=… prefills the address", async () => {
    const el = mount(
      { getMe: async () => Promise.reject(new Error("401")) } as Partial<ApiClient>,
      "/login?email=owner%40coffee.example",
    );
    await waitFor(() => q(el, "auth-email") !== null);
    expect((q(el, "auth-email") as HTMLInputElement).value).toBe("owner@coffee.example");
  });
});

describe("S6 publish card (M2)", () => {
  function card(codes: string[], cardBound?: boolean): HTMLDivElement {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const spec: RoleSpec = {
      app: { name: "Wizard" },
      role: null,
      roles: [],
      entities: [],
      permissions: [],
      pages: [],
      theme: { accent: "#2F46D8", font: "Onest", radius: 8, density: "regular", mode: "light" },
      loginMethods: [],
    };
    act(() =>
      root?.render(
        h(
          WzProvider,
          { spec, applyTheme: false },
          h(PublishCard, {
            systemId: SYS,
            slug: "forum",
            blockers: publishBlockers(codes, []),
            codes,
            prodRevision: null,
            prodUrl: null,
            revision: 2,
            showSubmit: true,
            running: false,
            busy: false,
            error: null,
            cardBound,
            onEdit: () => {},
            onPublish: () => {},
          }),
        ),
      ),
    );
    return container;
  }

  test("CARD_BINDING_REQUIRED → «Привязать карту» to S-billing; operator blockers → S10 «Персональные данные»", () => {
    const el = card(["CARD_BINDING_REQUIRED", "OPERATOR_NAME_REQUIRED"], false);
    expect(q(el, "publish-card-status")?.dataset.bound).toBe("false");
    expect(q(el, "publish-card-status")?.textContent).toBe(ru.publish.cardMissing);
    expect(q(el, "publish-to-billing")?.getAttribute("href")).toBe("/billing");
    expect(q(el, "publish-to-billing")?.textContent).toBe("Привязать карту");
    expect(q(el, "publish-to-settings")?.getAttribute("href")).toBe(`/s/${SYS}/settings#pd`);
    expect(btn(el, "publish-submit").disabled).toBe(true);
    click(q(el, "publish-to-settings"));
    expect(window.location.pathname).toBe(`/s/${SYS}/settings`);
    expect(window.location.hash).toBe("#pd");
  });

  test("bound card → «✓ Карта РФ привязана»; plan blockers link to S-billing; review pending explains the wait", () => {
    let el = card([], true);
    expect(q(el, "publish-card-status")?.textContent).toBe("✓ Карта РФ привязана — идентификация пройдена");
    expect(q(el, "publish-to-billing")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    el = card(["PHONE_LOGIN_PLAN_REQUIRED", "FOUNDER_REVIEW_PENDING"], true);
    expect(q(el, "publish-to-billing")?.textContent).toBe(ru.publish.toBilling);
    expect(el.textContent).toContain(ru.publish.reviewHint);
    expect(all(el, "publish-blocker").map((b) => b.textContent)).toEqual([
      ru.publish.blockers.PHONE_LOGIN_PLAN_REQUIRED,
      "Ждёт проверки",
    ]);
  });
});

describe("S10 (M2-11)", () => {
  function settingsApi(over: Partial<ApiClient> = {}): Partial<ApiClient> {
    return {
      getMe: async () => me("owner"),
      getOrgSettings: async () => ({}),
      getSystem: async () =>
        ({
          system: {
            id: SYS,
            orgId: ORG,
            name: "Форум",
            slug: "forum",
            stage: "ready",
            draftRevision: 5,
            prodRevision: 5,
            previewRevision: 5,
            prodUrl: "http://forum.localhost:4100",
          },
          messages: [],
        }) as never,
      getLock: async () => ({ held: false }),
      getRevision: async () =>
        ({
          version: 5,
          spec: {
            roles: [],
            entities: [],
            compliance: {
              operatorName: "ООО «Северный ритейл»",
              operatorContact: "privacy@north-retail.example",
              consentTemplateId: "event_registration",
            },
          },
          files: [],
          ops: [],
        }) as never,
      listMembers: async () => ({ items: [] }),
      listInvites: async () => ({ items: [] }),
      listRevisions: async () => ({ items: [] }),
      listPublications: async () => ({ items: [] }),
      listDeletionLog: async () => ({ items: [], nextCursor: null }),
      listExports: async () => ({ items: [] }),
      ...over,
    };
  }

  test("«Выгрузить данные»: personal data only after the confirmation; ready → a single-use ZIP link", async () => {
    const createExport = vi.fn(async () => ({ exportId: "e1", run: { id: "r1" } as never }));
    const getExport = vi.fn(async () => ({
      id: "e1",
      env: "prod" as const,
      status: "ready" as const,
      size: 2048,
      includePii: true,
      createdAt: "2026-10-01T09:00:00Z",
      downloadUrl: `http://localhost/api/v1/systems/${SYS}/exports/e1/download?token=t1`,
    }));
    const el = mount(
      settingsApi({
        createExport: createExport as unknown as ApiClient["createExport"],
        getExport: getExport as unknown as ApiClient["getExport"],
      }),
      `/s/${SYS}/settings`,
    );
    await waitFor(() => q(el, "settings-export") !== null && !btn(el, "settings-export").disabled);
    expect(q(el, "settings-pd-policy")?.querySelector("a")?.getAttribute("href")).toBe(
      "http://forum.localhost:4100/privacy",
    );
    click(q(el, "settings-export-pii"));
    click(q(el, "settings-export"));
    expect(q(el, "settings-export-pii-confirm")?.textContent).toContain("вместе с персональными данными");
    click(q(el, "settings-export-pii-no"));
    expect(createExport).not.toHaveBeenCalled();
    click(q(el, "settings-export"));
    click(q(el, "settings-export-pii-yes"));
    await waitFor(() => createExport.mock.calls.length === 1);
    expect(createExport).toHaveBeenCalledWith(SYS, { env: "prod", includePii: true });
    await waitFor(() => q(el, "settings-export-download") !== null, 400);
    expect(getExport).toHaveBeenCalledTimes(1);
    expect(q(el, "settings-export-download")?.getAttribute("href")).toContain(
      "/exports/e1/download?token=t1",
    );
    expect(q(el, "settings-export-status")?.textContent).toContain("2 КБ · с ПДн");
  });

  test("consent: the template by default, the owner's own text with a preview; «по шаблону» sends an empty text", async () => {
    const setCompliance = vi.fn(async (_id: string, _body: unknown) => ({
      revision: { version: 6 } as never,
    }));
    const el = mount(
      settingsApi({ setCompliance: setCompliance as unknown as ApiClient["setCompliance"] }),
      `/s/${SYS}/settings`,
    );
    await waitFor(() => q(el, "settings-pd-consent-template-id") !== null);
    expect((q(el, "settings-pd-consent-template-id") as HTMLSelectElement).value).toBe("event_registration");
    click(q(el, "settings-pd-consent-own"));
    const ta = q(el, "settings-pd-consent-text") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        ta,
        "Согласен на обработку",
      );
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(q(el, "settings-pd-consent-preview")?.textContent).toBe("Согласен на обработку");
    click(q(el, "settings-pd-consent-save"));
    await waitFor(() => setCompliance.mock.calls.length === 1);
    expect(setCompliance).toHaveBeenLastCalledWith(SYS, {
      expectedVersion: 5,
      operatorName: "ООО «Северный ритейл»",
      operatorContact: "privacy@north-retail.example",
      consentTemplateId: "event_registration",
      consentText: "Согласен на обработку",
    });
    click(q(el, "settings-pd-consent-template"));
    click(q(el, "settings-pd-consent-save"));
    await waitFor(() => setCompliance.mock.calls.length === 2);
    expect(setCompliance.mock.calls[1]?.[1]).toMatchObject({
      consentTemplateId: "event_registration",
      consentText: "",
    });
  });
});
