// @vitest-environment happy-dom
// M1-11 in the DOM with API doubles: S-auth (two separate consents for a new user, 429, safe next), S-invite (410),
// S10 (owner-only controls disabled for a viewer, «только РФ» → PATCH settings, t1Restricted text), L3-17 (no raw HTML).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, type ComponentProps, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { Me, OrgRole, OrgSettings } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { matchRoute, safeNext } from "../src/app/router.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const me = (role: OrgRole): Me => ({
  user: { id: "u1", email: "anna@example.test" },
  memberships: [{ orgId: ORG, orgName: "Северный ритейл", role }],
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  window.localStorage.clear();
});

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

function mountApp(api: Partial<ApiClient>, url: string): HTMLDivElement {
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const app: ReactElement = h(App);
  act(() =>
    root?.render(
      h(PlatformProvider, { api: api as ApiClient } as ComponentProps<typeof PlatformProvider>, app),
    ),
  );
  return container;
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = (el: HTMLElement, id: string) => q(el, id) as HTMLInputElement;
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: HTMLElement | null) => act(() => el?.click());

describe("router", () => {
  test("next after login is only a local path", () => {
    expect(safeNext("/s/1?x=2")).toBe("/s/1?x=2");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(matchRoute(`/s/${SYS}/settings`)).toEqual({ name: "settings", systemId: SYS });
    expect(matchRoute(`/invite/${"a".repeat(43)}`)).toEqual({ name: "invite", token: "a".repeat(43) });
  });
});

describe("S-auth", () => {
  const unauthorized = () =>
    Promise.reject(new ApiError(401, { code: "UNAUTHORIZED", message_ru: "Войдите" }));

  test("a private route without a session goes to /login?next=…", async () => {
    const el = mountApp({ getMe: unauthorized, getOrgSettings: unauthorized }, `/s/${SYS}`);
    await waitFor(() => q(el, "auth-email") !== null);
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("next")).toBe(`/s/${SYS}`);
  });

  test("new email: «код отправлен» for any address, both consents separate and required, then S1", async () => {
    let signedIn = false;
    const verify = vi.fn(async (b: { acceptOffer?: boolean; pdConsent?: boolean }) => {
      const missing = [...(b.acceptOffer ? [] : ["acceptOffer"]), ...(b.pdConsent ? [] : ["pdConsent"])];
      if (missing.length > 0)
        throw new ApiError(422, {
          code: "CONSENT_REQUIRED",
          message_ru: "Нужны согласия",
          details: { missing },
        });
      signedIn = true;
      return { user: me("owner").user };
    });
    const api: Partial<ApiClient> = {
      getMe: () => (signedIn ? Promise.resolve(me("owner")) : unauthorized()),
      requestOtp: vi.fn(async () => null),
      verifyOtp: verify as unknown as ApiClient["verifyOtp"],
      getOrgSettings: async () => ({ buildModelLabel: "модели в РФ" }),
      listSystems: async () => ({ items: [] }),
      listMembers: async () => ({ items: [] }),
    };
    const el = mountApp(api, "/login?next=%2F");
    await waitFor(() => q(el, "auth-email") !== null);
    type(input(el, "auth-email"), "new@example.test");
    click(q(el, "auth-request-code"));
    await waitFor(() => q(el, "auth-code") !== null);
    expect(el.textContent).toContain("Если адрес верный, код отправлен");
    expect(q(el, "auth-offer")).toBeNull();

    type(input(el, "auth-code"), "123456");
    click(q(el, "auth-submit"));
    await waitFor(() => q(el, "auth-offer") !== null);
    expect(input(el, "auth-offer").checked).toBe(false);
    expect(input(el, "auth-pd-consent").checked).toBe(false);
    expect(q(el, "auth-offer-error")).not.toBeNull();
    expect(q(el, "auth-pd-consent-error")).not.toBeNull();

    click(q(el, "auth-offer"));
    click(q(el, "auth-submit"));
    await waitFor(() => q(el, "auth-pd-consent-error") !== null && q(el, "auth-offer-error") === null);
    expect(verify).toHaveBeenCalledTimes(1); // the client does not send without the second consent

    click(q(el, "auth-pd-consent"));
    click(q(el, "auth-submit"));
    await waitFor(() => q(el, "start-prompt") !== null);
    expect(verify).toHaveBeenLastCalledWith({
      email: "new@example.test",
      code: "123456",
      acceptOffer: true,
      pdConsent: true,
    });
    expect(window.location.pathname).toBe("/");
  });

  test("429 → «Слишком много попыток»", async () => {
    const el = mountApp(
      {
        getMe: unauthorized,
        requestOtp: () => Promise.reject(new ApiError(429, { code: "RATE_LIMITED", message_ru: "x" })),
      },
      "/login",
    );
    await waitFor(() => q(el, "auth-email") !== null);
    type(input(el, "auth-email"), "a@example.test");
    click(q(el, "auth-request-code"));
    await waitFor(() => q(el, "auth-error") !== null);
    expect(q(el, "auth-error")?.textContent).toBe("Слишком много попыток. Попробуйте позже.");
  });
});

describe("S-invite", () => {
  test("410 INVITE_EXPIRED → «Приглашение устарело, попросите новое»", async () => {
    const el = mountApp(
      {
        getMe: async () => me("viewer"),
        getOrgSettings: async () => ({}),
        acceptInvite: () => Promise.reject(new ApiError(410, { code: "INVITE_EXPIRED", message_ru: "x" })),
      },
      `/invite/${"t".repeat(43)}`,
    );
    await waitFor(() => (q(el, "invite-accept") as HTMLButtonElement | null)?.disabled === false);
    click(q(el, "invite-accept"));
    await waitFor(() => q(el, "invite-error") !== null);
    expect(q(el, "invite-error")?.textContent).toBe("Приглашение устарело, попросите новое");
  });
});

describe("S10", () => {
  function settingsApi(role: OrgRole, settings: OrgSettings, patch = vi.fn()): Partial<ApiClient> {
    return {
      getMe: async () => me(role),
      getOrgSettings: async () => settings,
      updateOrgSettings: patch as unknown as ApiClient["updateOrgSettings"],
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
          },
          messages: [],
        }) as never,
      getLock: async () => ({ held: false }),
      getRevision: async () =>
        ({
          version: 5,
          spec: {
            roles: [
              { name: "participant", label: "Участник", loginMethods: ["email_otp", "phone_otp"] },
              { name: "visitor", label: "Посетитель", access: "public" },
            ],
            entities: [
              { name: "ticket", label: "Билет", retention: { deleteAfterDays: 30, mode: "anonymize" } },
            ],
          },
          files: [],
          ops: [],
        }) as never,
      listMembers: async () => ({ items: [{ userId: "u1", email: "anna@example.test", role }] }),
      listInvites: async () => ({ items: [] }),
      listRevisions: async () =>
        ({
          items: [
            { version: 5, summary_ru: "Поле «Тема трека»" },
            { version: 3, summary_ru: "Первая публикация" },
          ],
        }) as never,
      listPublications: async () =>
        ({
          items: [
            { id: "p2", env: "prod", revision: 5, status: "live", createdAt: "" },
            { id: "p1", env: "prod", revision: 3, status: "superseded", createdAt: "" },
          ],
        }) as never,
    };
  }

  test("viewer: settings-invite and revision-rollback disabled with a hint; the prod pill names the revision", async () => {
    const el = mountApp(settingsApi("viewer", { ruOnly: false, t1Restricted: false }), `/s/${SYS}/settings`);
    await waitFor(() => q(el, "revision-rollback") !== null);
    expect((q(el, "settings-invite") as HTMLButtonElement).disabled).toBe(true);
    expect((q(el, "revision-rollback") as HTMLButtonElement).disabled).toBe(true);
    expect(input(el, "settings-ru-only").disabled).toBe(true);
    expect(el.textContent).toContain("Доступно владельцу организации");
    expect(q(el, "settings-prod-revision")?.textContent).toBe("prod · ревизия 5");
    expect(q(el, "settings-login-methods")?.textContent).toContain("почта · телефон");
    expect(q(el, "settings-login-methods")?.textContent).toContain("только тарифы Старт и Бизнес");
    expect(q(el, "settings-retention")?.textContent).toContain("«Билет»: обезличивание через 30 дней");
  });

  test("owner: rollback asks «Вернуть prod к ревизии N? Данные сохранятся»; «только РФ» → PATCH settings", async () => {
    const patch = vi.fn(async (_org: string, b: { ruOnly: boolean }) => ({
      ruOnly: b.ruOnly,
      t1Restricted: false,
    }));
    const el = mountApp(
      settingsApi("owner", { ruOnly: false, t1Restricted: false }, patch),
      `/s/${SYS}/settings`,
    );
    await waitFor(() => q(el, "revision-rollback") !== null && !input(el, "settings-ru-only").disabled);
    expect((q(el, "revision-rollback") as HTMLButtonElement).disabled).toBe(false);
    click(q(el, "revision-rollback"));
    expect(q(el, "rollback-confirm")?.textContent).toContain("Вернуть prod к ревизии 3? Данные сохранятся");
    expect(document.activeElement).toBe(q(el, "rollback-yes"));
    click(q(el, "rollback-no"));
    expect(q(el, "rollback-confirm")).toBeNull();
    click(q(el, "settings-ru-only"));
    await waitFor(() => input(el, "settings-ru-only").checked);
    expect(patch).toHaveBeenCalledWith(ORG, { ruOnly: true });
  });

  test("M2-05 owner: deletion journal (labels, counters, no values, «Показать ещё»); «Удалить систему» confirms → DELETE → S1", async () => {
    const log = vi.fn(async (_id: string, cursor?: string) =>
      cursor
        ? {
            items: [
              {
                env: "prod" as const,
                entity: "users",
                mode: "consent_revoked",
                cutoff: null,
                rowsAffected: 1,
                createdAt: "2026-08-01T09:00:00.000Z",
              },
            ],
            nextCursor: null,
          }
        : {
            items: [
              {
                env: "prod" as const,
                entity: "ticket",
                mode: "anonymize",
                cutoff: "2026-09-01T00:00:00.000Z",
                rowsAffected: 3,
                createdAt: "2026-10-01T00:30:00.000Z",
              },
            ],
            nextCursor: "c1",
          },
    );
    const del = vi.fn(async (id: string) => ({
      id,
      deletedAt: "2026-10-01T10:00:00.000Z",
      purgeAfter: "2026-10-31T10:00:00.000Z",
    }));
    const el = mountApp(
      {
        ...settingsApi("owner", { ruOnly: false, t1Restricted: false }),
        listDeletionLog: log as unknown as ApiClient["listDeletionLog"],
        deleteSystem: del as unknown as ApiClient["deleteSystem"],
        listSystems: async () => ({ items: [] }),
      },
      `/s/${SYS}/settings`,
    );
    await waitFor(() => el.querySelectorAll('[data-testid="settings-deletion-row"]').length === 1);
    const row = q(el, "settings-deletion-row");
    expect(row?.dataset.mode).toBe("anonymize");
    expect(row?.textContent).toContain("Билет");
    expect(row?.textContent).toContain("обезличивание по сроку");
    expect(row?.textContent).toContain("3 записи");
    expect(row?.textContent).toContain("данные до 1 сентября 2026");
    click(q(el, "settings-deletion-more"));
    await waitFor(() => el.querySelectorAll('[data-testid="settings-deletion-row"]').length === 2);
    expect(log).toHaveBeenLastCalledWith(SYS, "c1");
    expect(q(el, "settings-deletion-log")?.textContent).toContain("пользователи");
    expect(q(el, "settings-deletion-log")?.textContent).toContain("отзыв согласия");
    expect(q(el, "settings-deletion-more")).toBeNull();

    const btn = q(el, "settings-delete-system") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    click(btn);
    expect(q(el, "settings-delete-confirm")?.textContent).toContain(
      "Удалить систему «Форум»? Она перестанет открываться сразу",
    );
    // Destructive: the focus starts on «Отмена».
    expect(document.activeElement).toBe(q(el, "settings-delete-no"));
    click(q(el, "settings-delete-no"));
    expect(q(el, "settings-delete-confirm")).toBeNull();
    expect(del).not.toHaveBeenCalled();
    click(q(el, "settings-delete-system"));
    click(q(el, "settings-delete-yes"));
    await waitFor(() => window.location.pathname === "/");
    expect(del).toHaveBeenCalledWith(SYS);
  });

  test("M2-05 viewer: «Удалить систему» disabled, the journal is not requested", async () => {
    const log = vi.fn();
    const el = mountApp(
      {
        ...settingsApi("viewer", { ruOnly: false, t1Restricted: false }),
        listDeletionLog: log as unknown as ApiClient["listDeletionLog"],
      },
      `/s/${SYS}/settings`,
    );
    await waitFor(() => q(el, "settings-delete-system") !== null);
    expect((q(el, "settings-delete-system") as HTMLButtonElement).disabled).toBe(true);
    expect(q(el, "settings-deletion-log")?.textContent).toContain("Доступно владельцу организации");
    expect(log).not.toHaveBeenCalled();
  });

  test("M2-05: SYSTEM_LOCKED on delete → «Идёт сборка или публикация…»", async () => {
    const el = mountApp(
      {
        ...settingsApi("owner", { ruOnly: false, t1Restricted: false }),
        listDeletionLog: async () => ({ items: [], nextCursor: null }),
        deleteSystem: () => Promise.reject(new ApiError(409, { code: "SYSTEM_LOCKED", message_ru: "x" })),
      },
      `/s/${SYS}/settings`,
    );
    await waitFor(() => q(el, "settings-deletion-empty") !== null);
    expect(q(el, "settings-deletion-empty")?.textContent).toBe("Удалений пока не было");
    click(q(el, "settings-delete-system"));
    click(q(el, "settings-delete-yes"));
    await waitFor(() => q(el, "settings-error") !== null);
    expect(q(el, "settings-error")?.textContent).toContain("Идёт сборка или публикация");
    expect(window.location.pathname).toBe(`/s/${SYS}/settings`);
  });

  test("t1Restricted: text «Сборка только на моделях в РФ (регион организации)» without the switch", async () => {
    const el = mountApp(settingsApi("owner", { ruOnly: false, t1Restricted: true }), `/s/${SYS}/settings`);
    await waitFor(() => q(el, "settings-ru-only") !== null && q(el, "settings-ru-only")?.tagName === "P");
    expect(q(el, "settings-ru-only")?.textContent).toBe("Сборка только на моделях в РФ (регион организации)");
  });
});

describe("L3-17", () => {
  test("platform-web never renders raw HTML (dangerouslySetInnerHTML, innerHTML)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    const offenders = files.filter((f) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
