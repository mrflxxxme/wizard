// @vitest-environment happy-dom
// Staff console «Пилот» in the DOM with API doubles (platform-screens.yaml#S-admin pilot): beta_readiness with
// who/when and the checklist, switching on needs a note and a second press; an invitation refused while readiness is
// off shows the API's Russian text; invite with the founder-review flag (on by default) → the link; invitation statuses
// and revoke only for «ждёт входа»; pilot orgs with grants by reference and the review toggle; the 80 % / 100 % LLM
// spend warnings; MFA_REQUIRED from the section returns to the code screen.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { LlmSpend, Me, PilotInvite, PilotOrg, PilotReadiness, StaffSession } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { ru } from "../src/i18n/ru.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = ru.admin.pilot;
const ORG = "22222222-2222-4222-8222-222222222222";
const PORG = "66666666-6666-4666-8666-666666666666";
const ME: Me = {
  user: { id: "u1", email: "founder@wizard.example" },
  memberships: [{ orgId: ORG, orgName: "Основатель", role: "owner" }],
};
const VERIFIED: StaffSession = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: "2026-10-02T00:00:00Z" };
const CHECKLIST = [
  { id: "rkn", text: "Подано уведомление в Роскомнадзор" },
  { id: "lawyer", text: "Юрист согласовал документы" },
  { id: "dpa", text: "Подписаны поручения" },
  { id: "zai", text: "Z.ai подтвердил или отключён" },
  { id: "security", text: "Документы в docs/security" },
];
const MISSING =
  "Приглашать партнёров пока нельзя: не отмечена готовность беты (beta_readiness, задача M2-13).";

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

function mount(api: Partial<ApiClient>): HTMLDivElement {
  window.history.replaceState(null, "", "/admin");
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

const q = <T extends HTMLElement = HTMLElement>(el: HTMLElement | null | undefined, id: string) =>
  el?.querySelector<T>(`[data-testid="${id}"]`) ?? null;
const all = (el: HTMLElement, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: HTMLElement | null) => act(() => el?.click());
function type(el: HTMLElement | null, value: string) {
  if (!el) throw new Error("no field");
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = (el: HTMLElement | null) =>
  act(() => {
    el?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

const invite = (over: Partial<PilotInvite>): PilotInvite => ({
  id: "i1",
  email: "owner@coffee.example",
  orgName: "Кофейня «Зерно»",
  credits: 100,
  requireFounderReview: true,
  status: "sent",
  createdAt: "2026-10-01T10:00:00Z",
  expiresAt: "2026-10-31T10:00:00Z",
  acceptedAt: null,
  orgId: null,
  ...over,
});
const ORG_ROW: PilotOrg = {
  id: PORG,
  name: "Кофейня «Зерно»",
  plan: "pilot",
  members: 2,
  requireFounderReview: true,
  creditsAvailable: 150,
  creditsSpentMonth: 12.5,
  modelSpendRub: 40.25,
};
const SPEND: LlmSpend = {
  month: "2026-10",
  spentRub: 100,
  capRub: 6000,
  sharePercent: 1,
  warn: false,
  reached: false,
};

/** A stateful double of the /admin/pilot API. */
function pilotApi(
  o: { readiness?: Partial<PilotReadiness>; invites?: PilotInvite[]; spend?: Partial<LlmSpend> } = {},
) {
  const state = {
    readiness: {
      on: false,
      by: null,
      at: null,
      note: null,
      checklist: CHECKLIST,
      ...o.readiness,
    } as PilotReadiness,
    invites: o.invites ?? [],
    orgs: [ORG_ROW],
  };
  const fns = {
    adminSetPilotReadiness: vi.fn(async (b: { on: boolean; confirm?: boolean; note?: string }) => {
      state.readiness = {
        ...state.readiness,
        on: b.on,
        by: "founder@wizard.example",
        at: "2026-10-01T12:00:00Z",
        note: b.note ?? null,
      };
      return state.readiness;
    }),
    adminCreatePilotInvite: vi.fn(
      async (b: { email: string; orgName?: string; credits?: number; requireFounderReview?: boolean }) => {
        if (!state.readiness.on) throw new ApiError(403, { code: "FORBIDDEN", message_ru: MISSING });
        state.invites = [
          invite({ id: "new", email: b.email, orgName: b.orgName ?? null, credits: b.credits ?? 0 }),
          ...state.invites,
        ];
        return {
          id: "new",
          email: b.email,
          expiresAt: "2026-10-31T10:00:00Z",
          link: `http://localhost:5173/login?email=${encodeURIComponent(b.email)}&next=%2Fwelcome`,
          requireFounderReview: b.requireFounderReview ?? true,
        };
      },
    ),
    adminRevokePilotInvite: vi.fn(async (id: string) => {
      state.invites = state.invites.filter((x) => x.id !== id);
      return { id, status: "revoked" as const };
    }),
    adminGrantPilotCredits: vi.fn(async (orgId: string, b: { credits: number; reference: string }) => {
      state.orgs = state.orgs.map((x) =>
        x.id === orgId ? { ...x, creditsAvailable: x.creditsAvailable + b.credits } : x,
      );
      return { orgId, granted: true, reference: b.reference, creditsAvailable: 150 + b.credits };
    }),
    adminSetPilotFounderReview: vi.fn(async (orgId: string, on: boolean) => {
      state.orgs = state.orgs.map((x) => (x.id === orgId ? { ...x, requireFounderReview: on } : x));
      return { orgId, requireFounderReview: on };
    }),
  };
  const api: Partial<ApiClient> = {
    getMe: async () => ME,
    getOrgSettings: async () => ({}) as never,
    listSystems: async () => ({ items: [] }),
    adminSession: async () => VERIFIED,
    adminListAbuseReports: async () => ({ items: [] }),
    adminPilotReadiness: async () => state.readiness,
    adminPilotSpend: async () => ({ ...SPEND, ...o.spend }),
    adminListPilotInvites: async () => ({ items: state.invites }),
    adminListPilotOrgs: async () => ({ month: "2026-10", capRub: 6000, items: state.orgs }),
    ...fns,
  };
  return { api, fns, state };
}

async function openPilot(api: Partial<ApiClient>): Promise<HTMLDivElement> {
  const el = mount(api);
  await waitFor(() => q(el, "admin-tab-pilot") !== null);
  click(q(el, "admin-tab-pilot"));
  await waitFor(() => q(el, "admin-pilot") !== null);
  return el;
}

describe("«Пилот»: beta_readiness", () => {
  test("off: checklist; invitation refused with the API text; on needs a note and a second press; who/when shown", async () => {
    const { api, fns } = pilotApi();
    const el = await openPilot(api);
    const block = q(el, "admin-pilot-readiness");
    expect(block?.dataset.on).toBe("false");
    expect(q(el, "admin-pilot-readiness-state")?.textContent).toBe(t.readinessOff);
    expect(q(el, "admin-pilot-readiness-by")?.textContent).toBe(t.readinessNever);
    expect(q(el, "admin-pilot-checklist")?.querySelectorAll("li")).toHaveLength(5);
    expect(q(el, "admin-pilot-checklist")?.textContent).toContain("Роскомнадзор");

    // The gate is the API's: the console shows its Russian refusal.
    type(q(el, "admin-pilot-invite-email"), "owner@coffee.example");
    submit(q(el, "admin-pilot-invite-submit"));
    await waitFor(() => q(el, "admin-pilot-invite-error") !== null);
    expect(q(el, "admin-pilot-invite-error")?.textContent).toBe(MISSING);

    click(q(el, "admin-pilot-readiness-toggle"));
    await waitFor(() => q(el, "admin-pilot-readiness-error") !== null);
    expect(q(el, "admin-pilot-readiness-error")?.textContent).toBe(t.readinessNoteRequired);
    type(q(el, "admin-pilot-readiness-note"), "РКН подано, юрист — ок");
    click(q(el, "admin-pilot-readiness-toggle"));
    await waitFor(() => q(el, "admin-pilot-readiness-confirm-text") !== null);
    expect(q(el, "admin-pilot-readiness-confirm-text")?.textContent).toBe(t.readinessConfirm);
    expect(fns.adminSetPilotReadiness).not.toHaveBeenCalled();
    click(q(el, "admin-pilot-readiness-toggle"));
    await waitFor(() => q(el, "admin-pilot-readiness")?.dataset.on === "true");
    expect(fns.adminSetPilotReadiness).toHaveBeenCalledWith({
      on: true,
      confirm: true,
      note: "РКН подано, юрист — ок",
    });
    expect(q(el, "admin-pilot-readiness-state")?.textContent).toBe(t.readinessOn);
    expect(q(el, "admin-pilot-readiness-by")?.textContent).toContain("Переключил founder@wizard.example");
    expect(q(el, "admin-pilot-readiness-by")?.textContent).toContain("РКН подано, юрист — ок");
    expect(q(el, "admin-pilot-readiness-toggle")?.textContent).toBe(t.readinessTurnOff);

    // Switching off is one press.
    click(q(el, "admin-pilot-readiness-toggle"));
    await waitFor(() => q(el, "admin-pilot-readiness")?.dataset.on === "false");
    expect(fns.adminSetPilotReadiness).toHaveBeenLastCalledWith({ on: false });
  });
});

describe("«Пилот»: invitations", () => {
  test("invite with the review flag (on by default, can be switched off) → the link; statuses; revoke only «ждёт входа»", async () => {
    const { api, fns } = pilotApi({
      readiness: { on: true, by: "founder@wizard.example", at: "2026-10-01T09:00:00Z" },
      invites: [
        invite({
          id: "acc",
          email: "a@example.ru",
          status: "accepted",
          acceptedAt: "2026-10-02T10:00:00Z",
          orgId: PORG,
        }),
        invite({ id: "exp", email: "e@example.ru", status: "expired" }),
      ],
    });
    const el = await openPilot(api);
    expect(q<HTMLInputElement>(el, "admin-pilot-invite-review")?.checked).toBe(true);
    expect(q<HTMLButtonElement>(el, "admin-pilot-invite-submit")?.disabled).toBe(true);
    type(q(el, "admin-pilot-invite-email"), "owner@coffee.example");
    type(q(el, "admin-pilot-invite-org"), "Кофейня «Зерно»");
    type(q(el, "admin-pilot-invite-credits"), "150");
    click(q(el, "admin-pilot-invite-review"));
    submit(q(el, "admin-pilot-invite-submit"));
    await waitFor(() => q(el, "admin-pilot-invite-done") !== null);
    expect(fns.adminCreatePilotInvite).toHaveBeenCalledWith({
      email: "owner@coffee.example",
      orgName: "Кофейня «Зерно»",
      credits: 150,
      requireFounderReview: false,
    });
    expect(q(el, "admin-pilot-invite-done")?.textContent).toContain(t.invited("owner@coffee.example"));
    expect(q(el, "admin-pilot-invite-link")?.textContent).toBe(
      "http://localhost:5173/login?email=owner%40coffee.example&next=%2Fwelcome",
    );
    // The form is reset with the review flag back on.
    expect(q<HTMLInputElement>(el, "admin-pilot-invite-review")?.checked).toBe(true);

    await waitFor(() => all(el, "admin-pilot-invite-row").length === 3);
    const rows = all(el, "admin-pilot-invite-row");
    expect(rows.map((r) => r.dataset.status)).toEqual(["sent", "accepted", "expired"]);
    expect(rows.map((r) => q(r, "admin-pilot-invite-status")?.textContent)).toEqual([
      "ждёт входа",
      "принято",
      "истекло",
    ]);
    expect(rows.map((r) => q(r, "admin-pilot-invite-revoke") !== null)).toEqual([true, false, false]);
    click(q(rows[0], "admin-pilot-invite-revoke"));
    await waitFor(() => all(el, "admin-pilot-invite-row").length === 2);
    expect(fns.adminRevokePilotInvite).toHaveBeenCalledWith("new");
  });
});

describe("«Пилот»: orgs and the platform spend", () => {
  test("org row: plan, members, credits, spend vs cap; grant needs a reference; review toggle", async () => {
    const { api, fns } = pilotApi({ readiness: { on: true } });
    const el = await openPilot(api);
    const row = q(el, "admin-pilot-org-row");
    expect(row?.dataset.id).toBe(PORG);
    const cells = [...(row?.querySelectorAll("td") ?? [])].map((c) => c.textContent);
    expect(cells.slice(0, 5)).toEqual(["Кофейня «Зерно»", "Пилот", "2", "150", "12,5"]);
    expect(cells[5]).toMatch(/^40,25 ₽ из 6\s000 ₽ лимита платформы$/);

    type(q(row, "admin-pilot-grant-credits"), "50");
    click(q(row, "admin-pilot-grant"));
    await waitFor(() => q(el, "admin-pilot-org-error") !== null);
    expect(q(el, "admin-pilot-org-error")?.textContent).toBe(t.grantInvalid);
    expect(fns.adminGrantPilotCredits).not.toHaveBeenCalled();
    type(q(row, "admin-pilot-grant-reference"), "договор № 7");
    click(q(row, "admin-pilot-grant"));
    await waitFor(() => q(el, "admin-pilot-org-notice") !== null);
    expect(fns.adminGrantPilotCredits).toHaveBeenCalledWith(PORG, { credits: 50, reference: "договор № 7" });
    expect(q(el, "admin-pilot-org-notice")?.textContent).toBe(t.granted(200));
    await waitFor(() => q(el, "admin-pilot-org-available")?.textContent === "200");

    expect(q<HTMLInputElement>(el, "admin-pilot-org-review")?.checked).toBe(true);
    click(q(el, "admin-pilot-org-review"));
    await waitFor(() => q<HTMLInputElement>(el, "admin-pilot-org-review")?.checked === false);
    expect(fns.adminSetPilotFounderReview).toHaveBeenCalledWith(PORG, false);
  });

  test.each([
    [{}, null],
    [{ spentRub: 4800, sharePercent: 80, warn: true }, t.spendWarn],
    [{ spentRub: 6000, sharePercent: 100, warn: true, reached: true }, t.spendReached],
  ] as const)("spend %j → warning %s", async (spend, warning) => {
    const { api } = pilotApi({ spend });
    const el = await openPilot(api);
    expect(q(el, "admin-pilot-spend-value")?.textContent).toMatch(
      /^2026-10: [\d\s,]+ ₽ из 6\s000 ₽ \(\d+ %\)$/,
    );
    expect(q(el, "admin-pilot-spend-warn")?.textContent ?? null).toBe(warning);
  });

  test("MFA_REQUIRED from the section → back to the code screen", async () => {
    let session: StaffSession = VERIFIED;
    const { api } = pilotApi();
    const el = mount({
      ...api,
      adminSession: async () => session,
      adminPilotSpend: async () => {
        session = { ...VERIFIED, mfaVerifiedUntil: null };
        throw new ApiError(403, { code: "MFA_REQUIRED", message_ru: "Подтвердите вход" });
      },
    });
    await waitFor(() => q(el, "admin-tab-pilot") !== null);
    click(q(el, "admin-tab-pilot"));
    await waitFor(() => q(el, "admin-verify") !== null);
  });
});
