// @vitest-environment happy-dom
// M2-08 in the DOM with API doubles: «Пожаловаться» (/abuse — prefilled URL, e-mail needs its consent, neutral
// confirmation), the staff console /admin (non-staff → «Страница не найдена», anon → /login, TOTP enrolment with
// recovery codes shown once, session step-up with a recovery-code mode, MFA_REQUIRED from any call → back to the code
// screen), the queue by SLA with timers, the ticket (journal note required, takedown confirmed first, staff data shown
// only with an open access) and founder reviews.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { AbuseReport, AbuseTicket, Me, StaffSession } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { ru } from "../src/i18n/ru.js";
import { slaText } from "../src/screens/admin/AdminConsole.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const R2 = "55555555-5555-4555-8555-555555555555";
const ME: Me = {
  user: { id: "u1", email: "founder@wizard.example" },
  memberships: [{ orgId: ORG, orgName: "Основатель", role: "owner" }],
};
const VERIFIED: StaffSession = {
  isStaff: true,
  mfaEnrolled: true,
  mfaVerifiedUntil: "2026-10-02T00:00:00Z",
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

const q = <T extends HTMLElement = HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);
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
function choose(el: HTMLElement | null, value: string) {
  if (!el) throw new Error("no select");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const submit = (el: HTMLElement | null) =>
  act(() => {
    el?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

const base = (over: Partial<ApiClient>): Partial<ApiClient> => ({
  getMe: async () => ME,
  getOrgSettings: async () => ({}) as never,
  listSystems: async () => ({ items: [] }),
  ...over,
});

describe("«Пожаловаться» (/abuse)", () => {
  test("public: URL prefilled from ?url, e-mail needs its consent, neutral confirmation", async () => {
    const createAbuseReport = vi.fn(async () => ({ reportId: R1 }));
    const el = mount(
      {
        getMe: async () => {
          throw new ApiError(401, { code: "UNAUTHORIZED", message_ru: "Войдите" });
        },
        getOrgSettings: async () => ({}) as never,
        createAbuseReport,
      },
      `/abuse?url=${encodeURIComponent("http://forum.localhost:4100/tickets")}`,
    );
    await waitFor(() => q(el, "abuse-form") !== null);
    expect(window.location.pathname).toBe("/abuse");
    expect(q<HTMLInputElement>(el, "abuse-url")?.value).toBe("http://forum.localhost:4100/tickets");
    choose(q(el, "abuse-category"), "fraud");
    type(q(el, "abuse-text"), "Просят перевести деньги на карту");
    type(q(el, "abuse-contact"), "me@example.test");
    expect(q(el, "abuse-consent")).not.toBeNull();
    submit(q(el, "abuse-submit"));
    await waitFor(() => q(el, "abuse-error") !== null);
    expect(q(el, "abuse-error")?.textContent).toBe(ru.abuse.consentRequired);
    expect(createAbuseReport).not.toHaveBeenCalled();
    click(q(el, "abuse-consent"));
    submit(q(el, "abuse-submit"));
    await waitFor(() => q(el, "abuse-done") !== null);
    expect(createAbuseReport).toHaveBeenCalledWith({
      url: "http://forum.localhost:4100/tickets",
      category: "fraud",
      text: "Просят перевести деньги на карту",
      contactEmail: "me@example.test",
      contactConsent: true,
    });
    expect(q(el, "abuse-done")?.textContent).toBe(ru.abuse.done);
  });

  test("429 from the API is shown in Russian", async () => {
    const el = mount(
      base({
        createAbuseReport: async () => {
          throw new ApiError(429, {
            code: "RATE_LIMITED",
            message_ru: "Слишком много жалоб — попробуйте через час",
          });
        },
      }),
      "/abuse",
    );
    await waitFor(() => q(el, "abuse-form") !== null);
    type(q(el, "abuse-url"), "http://forum.localhost:4100/");
    submit(q(el, "abuse-submit"));
    await waitFor(() => q(el, "abuse-error") !== null);
    expect(q(el, "abuse-error")?.textContent).toContain("Слишком много жалоб");
  });
});

describe("/admin access", () => {
  test("non-staff (API 404) → «Страница не найдена»; no admin calls beyond the session", async () => {
    const adminListAbuseReports = vi.fn();
    const el = mount(
      base({
        adminSession: async () => {
          throw new ApiError(404, { code: "NOT_FOUND", message_ru: "Страница не найдена" });
        },
        adminListAbuseReports,
      }),
      "/admin",
    );
    await waitFor(() => q(el, "admin-not-found") !== null);
    expect(adminListAbuseReports).not.toHaveBeenCalled();
  });

  test("without a session → /login?next=/admin", async () => {
    mount(
      {
        getMe: async () => {
          throw new ApiError(401, { code: "UNAUTHORIZED", message_ru: "Войдите" });
        },
        getOrgSettings: async () => ({}) as never,
      },
      "/admin",
    );
    await waitFor(() => window.location.pathname === "/login");
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/admin");
  });

  test("enrolment: key → code → recovery codes once → console", async () => {
    let session: StaffSession = { isStaff: true, mfaEnrolled: false, mfaVerifiedUntil: null };
    const adminMfaConfirm = vi.fn(async () => {
      session = VERIFIED;
      return { recoveryCodes: ["abcde-fghjk", "mnpqr-stuvw"], mfaVerifiedUntil: "2026-10-02T00:00:00Z" };
    });
    const el = mount(
      base({
        adminSession: async () => session,
        adminMfaEnroll: async () => ({
          secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
          otpauthUrl: "otpauth://totp/Wizard:founder?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        }),
        adminMfaConfirm,
        adminListAbuseReports: async () => ({ items: [] }),
      }),
      "/admin",
    );
    await waitFor(() => q(el, "admin-mfa-start") !== null);
    click(q(el, "admin-mfa-start"));
    await waitFor(() => q(el, "admin-mfa-secret") !== null);
    expect(q(el, "admin-mfa-secret")?.dataset.secret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(q(el, "admin-mfa-secret")?.textContent).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(q<HTMLAnchorElement>(el, "admin-mfa-otpauth")?.getAttribute("href")).toMatch(
      /^otpauth:\/\/totp\//,
    );
    expect(q<HTMLButtonElement>(el, "admin-mfa-confirm")?.disabled).toBe(true);
    type(q(el, "admin-mfa-code"), "12a3456");
    expect(q<HTMLInputElement>(el, "admin-mfa-code")?.value).toBe("123456");
    submit(q(el, "admin-mfa-confirm"));
    await waitFor(() => q(el, "admin-recovery-codes") !== null);
    expect(adminMfaConfirm).toHaveBeenCalledWith("123456");
    expect(all(el, "admin-recovery-codes")[0]?.textContent).toContain("abcde-fghjk");
    click(q(el, "admin-recovery-done"));
    await waitFor(() => q(el, "admin-console") !== null);
    expect(q(el, "admin-recovery-codes")).toBeNull();
  });

  test("step-up: wrong code shows the error; recovery-code mode", async () => {
    let session: StaffSession = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: null };
    const adminMfaVerify = vi.fn(async (b: { code: string } | { recoveryCode: string }) => {
      if ("code" in b) throw new ApiError(401, { code: "OTP_INVALID", message_ru: "Неверный код" });
      session = VERIFIED;
      return { mfaVerifiedUntil: "2026-10-02T00:00:00Z" };
    });
    const el = mount(
      base({
        adminSession: async () => session,
        adminMfaVerify: adminMfaVerify as unknown as ApiClient["adminMfaVerify"],
        adminListAbuseReports: async () => ({ items: [] }),
      }),
      "/admin",
    );
    await waitFor(() => q(el, "admin-verify") !== null);
    type(q(el, "admin-mfa-code"), "000000");
    submit(q(el, "admin-mfa-verify"));
    await waitFor(() => q(el, "admin-mfa-error") !== null);
    expect(q(el, "admin-mfa-error")?.textContent).toBe("Неверный код");
    click(q(el, "admin-mfa-toggle"));
    type(q(el, "admin-mfa-recovery"), "abcde-fghjk");
    submit(q(el, "admin-mfa-verify"));
    await waitFor(() => q(el, "admin-console") !== null);
    expect(adminMfaVerify).toHaveBeenLastCalledWith({ recoveryCode: "abcde-fghjk" });
  });

  test("MFA_REQUIRED from the queue (step-up expired) → back to the code screen", async () => {
    let session: StaffSession = VERIFIED;
    const el = mount(
      base({
        adminSession: async () => session,
        adminListAbuseReports: async () => {
          session = { ...VERIFIED, mfaVerifiedUntil: null };
          throw new ApiError(403, { code: "MFA_REQUIRED", message_ru: "Подтвердите вход" });
        },
      }),
      "/admin",
    );
    await waitFor(() => q(el, "admin-verify") !== null);
  });
});

const NOW = Date.now();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const reports: AbuseReport[] = [
  {
    id: R1,
    systemId: SYS,
    category: "phishing",
    status: "new",
    slaDeadline: iso(90 * 60_000),
    createdAt: iso(-22.5 * 3600_000),
    url: "http://forum.localhost:4100/login",
    resolvedAt: null,
    systemName: "Форум",
  },
  {
    id: R2,
    systemId: null,
    category: "spam",
    status: "new",
    slaDeadline: iso(-30 * 60_000),
    createdAt: iso(-24.5 * 3600_000),
    url: "http://gone.localhost:4100/",
    resolvedAt: null,
    systemName: null,
  },
];

function ticket(over: Partial<AbuseTicket> = {}): AbuseTicket {
  return {
    ...(reports[0] as AbuseReport),
    text: "Форма входа банка",
    contactEmail: "reporter@example.test",
    resolutionNote: null,
    system: { id: SYS, name: "Форум", orgId: ORG, prodUrl: "http://forum.localhost:4100/", suspended: false },
    access: null,
    journal: [],
    ...over,
  };
}

describe("console: queue, ticket, reviews", () => {
  test("SLA text", () => {
    expect(slaText(new Date(NOW + 90 * 60_000).toISOString(), NOW)).toEqual({
      text: "осталось 1 ч 30 мин",
      late: false,
    });
    expect(slaText(new Date(NOW - 61 * 60_000).toISOString(), NOW)).toEqual({
      text: "просрочено на 1 ч 1 мин",
      late: true,
    });
  });

  test("queue with SLA timers; ticket: note required, triage, data only with access, takedown confirmed first", async () => {
    let t = ticket();
    const adminAbuseAction = vi.fn(async (_id: string, b: { action: string }) => {
      if (b.action === "triage") t = ticket({ status: "triaged", access: { until: iso(24 * 3600_000) } });
      if (b.action === "takedown")
        t = ticket({
          status: "takedown",
          system: { ...(t.system as NonNullable<AbuseTicket["system"]>), suspended: true },
        });
      return t;
    });
    const adminSystemData = vi.fn(async (_id: string, entity?: string) => ({
      env: "prod" as const,
      revision: 3,
      omittedPii: 4,
      entities: [
        { name: "users", label: "users", rows: 1 },
        { name: "stream", label: "Поток", rows: 2 },
      ],
      entity: entity ?? "users",
      columns: ["id", "name"],
      rows: [{ id: "1", name: entity === "stream" ? "Зал А" : null }],
    }));
    const el = mount(
      base({
        adminSession: async () => VERIFIED,
        adminListAbuseReports: async () => ({ items: reports }),
        adminGetAbuseReport: async () => t,
        adminAbuseAction: adminAbuseAction as unknown as ApiClient["adminAbuseAction"],
        adminSystemData: adminSystemData as unknown as ApiClient["adminSystemData"],
      }),
      "/admin",
    );
    await waitFor(() => all(el, "admin-report-row").length === 2);
    const slas = all(el, "admin-report-sla").map((x) => x.textContent);
    expect(slas[0]).toMatch(/^осталось 1 ч (29|30) мин$/);
    expect(slas[1]).toMatch(/^просрочено на 0 ч (30|31) мин$/);
    expect(all(el, "admin-report-row")[1]?.textContent).toContain(ru.admin.noSystem);

    click(all(el, "admin-report-row")[0] as HTMLElement);
    await waitFor(() => q(el, "admin-ticket") !== null);
    expect(new URLSearchParams(window.location.search).get("report")).toBe(R1);
    expect(q(el, "admin-ticket-url")?.textContent).toBe("http://forum.localhost:4100/login");
    expect(q(el, "admin-ticket-access")?.textContent).toBe(ru.admin.accessNone);
    expect(q(el, "admin-data")).toBeNull();
    expect(adminSystemData).not.toHaveBeenCalled();
    expect(el.textContent).toContain(ru.admin.phishingNote);

    click(q(el, "admin-act-triage"));
    expect(q(el, "admin-ticket-error")?.textContent).toBe(ru.admin.noteRequired);
    expect(adminAbuseAction).not.toHaveBeenCalled();
    type(q(el, "admin-note"), "Проверяю форму входа");
    click(q(el, "admin-act-triage"));
    await waitFor(() => q(el, "admin-data-table") !== null);
    expect(adminAbuseAction).toHaveBeenCalledWith(R1, { action: "triage", note: "Проверяю форму входа" });
    expect(q(el, "admin-ticket")?.dataset.status).toBe("triaged");
    expect(el.textContent).toContain(ru.admin.dataOmitted(4));
    choose(q(el, "admin-data-entity"), "stream");
    await waitFor(() => q(el, "admin-data-table")?.textContent?.includes("Зал А") === true);
    expect(adminSystemData).toHaveBeenLastCalledWith(R1, "stream");

    type(q(el, "admin-note"), "Подтверждён фишинг");
    click(q(el, "admin-act-takedown"));
    expect(q(el, "admin-takedown-confirm-text")?.textContent).toBe(ru.admin.takedownConfirm);
    expect(adminAbuseAction).toHaveBeenCalledTimes(1);
    click(q(el, "admin-act-takedown"));
    await waitFor(() => q(el, "admin-ticket")?.dataset.status === "takedown");
    expect(adminAbuseAction).toHaveBeenLastCalledWith(R1, { action: "takedown", note: "Подтверждён фишинг" });
    expect(q(el, "admin-ticket-suspended")).not.toBeNull();
    expect(q(el, "admin-act-restore")).not.toBeNull();
    expect(q(el, "admin-act-takedown")).toBeNull();

    click(q(el, "admin-back"));
    await waitFor(() => q(el, "admin-queue") !== null);
  });

  test("org-wide suspension: confirmed first, sent with the ticket; then «Восстановить организацию»", async () => {
    let t = ticket({
      status: "takedown",
      system: { ...(ticket().system as NonNullable<AbuseTicket["system"]>), suspended: true },
    });
    const adminOrgSuspension = vi.fn(async (orgId: string, b: { action: string }) => {
      t = ticket({
        status: "takedown",
        system: { ...(t.system as NonNullable<AbuseTicket["system"]>), orgSuspended: b.action === "suspend" },
      });
      return { orgId, suspendedAt: b.action === "suspend" ? iso(0) : null };
    });
    const el = mount(
      base({
        adminSession: async () => VERIFIED,
        adminGetAbuseReport: async () => t,
        adminOrgSuspension: adminOrgSuspension as unknown as ApiClient["adminOrgSuspension"],
      }),
      `/admin?report=${R1}`,
    );
    await waitFor(() => q(el, "admin-act-org-suspend") !== null);
    expect(q(el, "admin-act-org-restore")).toBeNull();
    type(q(el, "admin-note"), "Повторный фишинг в организации");
    click(q(el, "admin-act-org-suspend"));
    expect(q(el, "admin-org-suspend-confirm-text")?.textContent).toBe(ru.admin.orgSuspendConfirm);
    expect(adminOrgSuspension).not.toHaveBeenCalled();
    click(q(el, "admin-act-org-suspend"));
    await waitFor(() => q(el, "admin-ticket-org-suspended") !== null);
    expect(adminOrgSuspension).toHaveBeenCalledWith(ORG, {
      action: "suspend",
      note: "Повторный фишинг в организации",
      reportId: R1,
    });
    expect(q(el, "admin-act-org-suspend")).toBeNull();
    type(q(el, "admin-note"), "Владелец удалил фишинговые системы");
    click(q(el, "admin-act-org-restore"));
    await waitFor(() => q(el, "admin-ticket-org-suspended") === null);
    expect(adminOrgSuspension).toHaveBeenLastCalledWith(ORG, {
      action: "restore",
      note: "Владелец удалил фишинговые системы",
      reportId: R1,
    });
  });

  test("founder reviews: approve and reject with a note", async () => {
    let items = [{ systemId: SYS, systemName: "Форум", orgId: ORG, revision: 7, createdAt: iso(-3600_000) }];
    const adminFounderReview = vi.fn(async () => {
      items = [];
      return { systemId: SYS, revision: 7, status: "approved" };
    });
    const el = mount(
      base({
        adminSession: async () => VERIFIED,
        adminListAbuseReports: async () => ({ items: [] }),
        adminListFounderReviews: async () => ({ items }),
        adminFounderReview,
      }),
      "/admin",
    );
    await waitFor(() => q(el, "admin-tab-reviews") !== null);
    click(q(el, "admin-tab-reviews"));
    await waitFor(() => all(el, "admin-review-row").length === 1);
    expect(all(el, "admin-review-row")[0]?.textContent).toContain("ревизия 7");
    type(q(el, "admin-review-note"), "Проверено");
    click(q(el, "admin-review-approve"));
    await waitFor(() => all(el, "admin-review-row").length === 0);
    expect(adminFounderReview).toHaveBeenCalledWith(SYS, {
      revision: 7,
      decision: "approve",
      note: "Проверено",
    });
    expect(el.textContent).toContain(ru.admin.emptyReviews);
  });
});
