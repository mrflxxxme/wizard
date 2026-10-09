// @vitest-environment happy-dom
// V3-18: the staff console tab «Системы и сбои» with API doubles — client systems (org, stage, published revision, the
// last build, spend) and failed runs (org, system, kind, code, the client's Russian text, cost); MFA_REQUIRED from the
// section returns to the code screen.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { AdminRun, AdminSystem, Me, StaffSession } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const ME: Me = {
  user: { id: "u1", email: "founder@wizard.example" },
  memberships: [{ orgId: ORG, orgName: "Основатель", role: "owner" }],
};
const VERIFIED: StaffSession = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: "2026-10-02T00:00:00Z" };

const SYSTEM: AdminSystem = {
  id: "s1",
  name: "Стоматология «Улыбка»",
  slug: "ulybka",
  org: { id: "o1", name: "ООО «Улыбка»", kind: "client" },
  stage: "ready",
  suspended: false,
  draftRevision: 4,
  previewRevision: 4,
  publishedRevision: 3,
  lastBuild: { status: "failed", failureCode: "G1_FAILED", at: "2026-10-08T10:00:00Z" },
  modelSpendRub: 42.5,
  creditsUsed: 12,
  lastActivityAt: "2026-10-08T10:00:00Z",
  createdAt: "2026-10-01T10:00:00Z",
};
const RUN: AdminRun = {
  id: "r1",
  org: { id: "o1", name: "ООО «Улыбка»" },
  system: { id: "s1", name: "Стоматология «Улыбка»" },
  kind: "build",
  mode: "change",
  status: "failed",
  errorCode: "G1_FAILED",
  messageRu: "Проверка сценариев не прошла",
  modelSpendRub: 7.25,
  creditsUsed: 3,
  createdAt: "2026-10-08T09:55:00Z",
  finishedAt: "2026-10-08T10:00:00Z",
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

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (el: HTMLElement, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

function baseApi(over: Partial<ApiClient> = {}): Partial<ApiClient> {
  return {
    getMe: async () => ME,
    getOrgSettings: async () => ({}) as never,
    listSystems: async () => ({ items: [] }),
    adminSession: async () => VERIFIED,
    adminListAbuseReports: async () => ({ items: [] }),
    ...over,
  };
}

describe("«Системы и сбои»", () => {
  test("systems with the last build and spend; failed runs with the code, the client's text and cost", async () => {
    const runs = vi.fn(async () => ({ items: [RUN] }));
    const el = mount(baseApi({ adminListSystems: async () => ({ items: [SYSTEM] }), adminListRuns: runs }));
    await waitFor(() => q(el, "admin-tab-systems") !== null);
    act(() => q(el, "admin-tab-systems")?.click());
    await waitFor(() => q(el, "admin-systems") !== null);
    expect(runs).toHaveBeenCalledWith("failed");

    const [sys] = all(el, "admin-system-row");
    expect(sys?.dataset.system).toBe("s1");
    const cells = [...(sys?.querySelectorAll("td") ?? [])].map((td) => td.textContent ?? "");
    expect(cells[0]).toBe("ООО «Улыбка»");
    expect(cells[1]).toBe("Стоматология «Улыбка»");
    expect(cells[2]).toBe("готова");
    expect(cells[3]).toBe("r3");
    expect(cells[4]).toContain("сбой");
    expect(cells[4]).toContain("G1_FAILED");
    expect(cells[5]).toMatch(/^42,5\s₽$/);
    expect(cells[6]).toBe("12");

    const [run] = all(el, "admin-run-row");
    const rc = [...(run?.querySelectorAll("td") ?? [])].map((td) => td.textContent ?? "");
    expect(rc.slice(1, 6)).toEqual([
      "ООО «Улыбка»",
      "Стоматология «Улыбка»",
      "сборка",
      "G1_FAILED",
      "Проверка сценариев не прошла",
    ]);
    expect(rc[6]).toMatch(/^7,25\s₽ · 3 кр\.$/);
  });

  test("empty lists say so; a system never published or built shows «нет» / «не было»", async () => {
    const fresh: AdminSystem = { ...SYSTEM, publishedRevision: null, lastBuild: null };
    const el = mount(
      baseApi({
        adminListSystems: async () => ({ items: [fresh] }),
        adminListRuns: async () => ({ items: [] }),
      }),
    );
    await waitFor(() => q(el, "admin-tab-systems") !== null);
    act(() => q(el, "admin-tab-systems")?.click());
    await waitFor(() => q(el, "admin-systems") !== null);
    const cells = [...(q(el, "admin-system-row")?.querySelectorAll("td") ?? [])].map((td) => td.textContent);
    expect(cells[3]).toBe("нет");
    expect(cells[4]).toBe("не было");
    expect(q(el, "admin-runs-failed")?.textContent).toContain("Сбоев нет");
  });

  test("MFA_REQUIRED from the section → back to the code screen", async () => {
    let session: StaffSession = VERIFIED;
    const el = mount(
      baseApi({
        adminSession: async () => session,
        adminListSystems: async () => {
          session = { ...VERIFIED, mfaVerifiedUntil: null };
          throw new ApiError(403, { code: "MFA_REQUIRED", message_ru: "Подтвердите вход" });
        },
        adminListRuns: async () => ({ items: [] }),
      }),
    );
    await waitFor(() => q(el, "admin-tab-systems") !== null);
    act(() => q(el, "admin-tab-systems")?.click());
    await waitFor(() => q(el, "admin-verify") !== null);
  });
});
