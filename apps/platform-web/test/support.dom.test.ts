// @vitest-environment happy-dom
// D68 «Написать команде» (M2-57 mvp_scope) in the DOM with API doubles: the button is on cabinet screens (not on
// /admin or sign-in), the dialog keeps focus and closes on Esc, sends text, «Хочу, чтобы доделала команда», the open
// system and the screen, and shows the confirmation (role=status); a limit error offers the same form; «Пока не умеем»
// in the chat pre-fills it; /admin «Обращения» shows client text as text and marks answered; S3/S4/S6 keep levels,
// check ids and file:line under «Подробнее для специалиста».
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { GateReport, Me, Message, SupportRequestItem } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { ChatFeed } from "../src/screens/workspace/ChatFeed.js";
import { GateReportView } from "../src/screens/workspace/GateReport.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const me: Me = {
  user: { id: "u1", email: "anna@bakery.example" },
  memberships: [{ orgId: ORG, orgName: "Пекарня", role: "owner" }],
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

function render(node: ReturnType<typeof h>, url = "/"): HTMLDivElement {
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

const app = (api: Partial<ApiClient>, url: string) =>
  render(
    h(PlatformProvider, { api: api as ApiClient } as ComponentProps<typeof PlatformProvider>, h(App)),
    url,
  );

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => act(() => el?.click());
function type(el: HTMLElement | null, value: string) {
  const ta = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** API double: the given methods; any other one answers 404 (screens behind the dialog stay quiet). */
function baseApi(over: Partial<ApiClient> = {}): Partial<ApiClient> {
  const known: Partial<ApiClient> = {
    getMe: async () => me,
    getOrgSettings: async () => ({}) as never,
    getOrg: async () => ({ id: ORG, name: "Пекарня", plan: "pilot", paymentsEnabled: false }),
    listSystems: async () => ({ items: [] }),
    listMembers: async () => ({ items: [] }),
    ...over,
  };
  return new Proxy(known, {
    get(t, k) {
      if (k in t || typeof k !== "string" || k === "then") return Reflect.get(t, k);
      return async () => {
        throw new ApiError(404, { code: "NOT_FOUND", message_ru: "Не найдено" });
      };
    },
  });
}

describe("«Написать команде» on cabinet screens", () => {
  test("S1: button → dialog with focus; Esc closes; empty text is refused", async () => {
    const el = app(baseApi(), "/");
    await waitFor(() => q(el, "support-open") !== null);
    expect(q(el, "support-open")?.textContent).toBe("Написать команде");
    click(q(el, "support-open"));
    const dialog = q(el, "support-dialog");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(q(el, "support-text"));
    click(q(el, "support-send"));
    expect(q(el, "support-error")?.textContent).toBe("Напишите сообщение");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(q(el, "support-dialog")).toBeNull();
  });

  test("from a system: sends text, the team flag, the system and the screen; shows the reply time", async () => {
    const send = vi.fn(async () => ({
      id: "r1",
      replyBy: "2026-10-12T08:30:00Z",
      message_ru:
        "Сообщение отправлено. Ответим письмом на anna@bakery.example в понедельник до 11:30 по московскому времени.",
    }));
    const el = app(
      baseApi({
        createSupportRequest: send as unknown as ApiClient["createSupportRequest"],
        getSystem: (async () => {
          throw new ApiError(500, null);
        }) as unknown as ApiClient["getSystem"],
      }),
      `/s/${SYS}/settings`,
    );
    await waitFor(() => q(el, "support-open") !== null);
    click(q(el, "support-open"));
    expect(q(el, "support-system")?.textContent).toBe("Приложим ссылку на открытую систему.");
    type(q(el, "support-text"), "Хочу оплату картой");
    click(q(el, "support-wants-team"));
    await act(async () => {
      q(el, "support-send")?.click();
    });
    await waitFor(() => q(el, "support-done") !== null);
    expect(send).toHaveBeenCalledWith({
      text: "Хочу оплату картой",
      wantsTeam: true,
      screen: "settings",
      systemId: SYS,
    });
    expect(q(el, "support-done")?.getAttribute("role")).toBe("status");
    expect(q(el, "support-done")?.textContent).toContain("в понедельник до 11:30");
  });

  test("a 429 shows the server text; /admin and /login have no button", async () => {
    const el = app(
      baseApi({
        createSupportRequest: (async () => {
          throw new ApiError(429, {
            code: "RATE_LIMITED",
            message_ru: "Сообщений за последний час слишком много.",
          });
        }) as unknown as ApiClient["createSupportRequest"],
      }),
      "/billing",
    );
    await waitFor(() => q(el, "support-open") !== null);
    click(q(el, "support-open"));
    type(q(el, "support-text"), "Ещё вопрос");
    await act(async () => {
      q(el, "support-send")?.click();
    });
    await waitFor(() => q(el, "support-error") !== null);
    expect(q(el, "support-error")?.textContent).toBe("Сообщений за последний час слишком много.");
    act(() => root?.unmount());
    container?.remove();
    const login = app(
      baseApi({
        getMe: (async () => {
          throw new ApiError(401, { code: "UNAUTHORIZED", message_ru: "Войдите" });
        }) as unknown as ApiClient["getMe"],
      }),
      "/login",
    );
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(q(login, "support-open")).toBeNull();
  });

  test("S1 limit error → «Написать команде» instead of «Пополнить»", async () => {
    const el = app(
      baseApi({
        createSystem: (async () => {
          throw new ApiError(402, {
            code: "INSUFFICIENT_CREDITS",
            message_ru: "Сейчас не получается продолжить сборку: закончился внутренний запас организации.",
          });
        }) as unknown as ApiClient["createSystem"],
      }),
      "/",
    );
    await waitFor(() => q(el, "start-prompt") !== null);
    type(q(el, "start-prompt"), "Запись в салон");
    await act(async () => {
      q(el, "start-submit")?.click();
    });
    await waitFor(() => q(el, "team-button") !== null);
    expect(el.textContent).not.toMatch(/Пополнить|Докупить|кредит/);
    click(q(el, "team-button"));
    expect(q(el, "support-dialog")).not.toBeNull();
  });
});

describe("chat and checks", () => {
  test("«Пока не умеем» (payload.gaps) → «Написать команде» pre-filled with the request", async () => {
    const m: Message = {
      id: "1",
      seq: 1,
      role: "assistant",
      kind: "questions",
      text: "Пока не умеем: приём оплаты на сайте.",
      payload: {
        gaps: [{ category: "payments", quote: "оплата", missing: "приём оплаты на сайте", offered: null }],
      },
      createdAt: "2026-10-05T10:00:00Z",
    };
    const el = render(
      h(
        PlatformProvider,
        { api: baseApi() as ApiClient } as ComponentProps<typeof PlatformProvider>,
        h(ChatFeed, { messages: [m] }),
      ),
    );
    const opened: unknown[] = [];
    const on = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("wz:support", on);
    expect(q(el, "chat-gap-team")?.textContent).toBe("Написать команде");
    click(q(el, "chat-gap-team"));
    window.removeEventListener("wz:support", on);
    expect(opened).toEqual([
      {
        wantsTeam: true,
        text: "Хочу, чтобы в системе было: приём оплаты на сайте. Можете помочь это сделать?",
      },
    ]);
  });

  test("gate report: human names; levels, check ids and file:line only under «Подробнее для специалиста»", () => {
    const r: GateReport = {
      level: "G2",
      passed: false,
      specVersion: 3,
      durationMs: 10,
      summary: { pass: 1, fail: 1, warn: 0, skip: 0, error: 0 },
      checks: [
        { id: "G2-RLS-01", status: "pass", severity: "blocker", message_ru: "Права проверены" },
        {
          id: "G2-PII-03",
          status: "fail",
          severity: "blocker",
          message_ru: "Нет согласия на обработку данных",
          file: "ui/Form.tsx",
          line: 12,
        },
      ],
    };
    const el = render(h(GateReportView, { reports: [r] }));
    const row = q(el, "gate-report-row-G2") as HTMLElement;
    expect(row.querySelector("b")?.textContent).toBe("Проверка прав доступа, данных и согласий");
    const details = q(el, "gate-report-specialist-G2");
    // Closed disclosure until expanded: the technical part sits only inside it.
    const outside = (row.textContent ?? "").replace(details?.textContent ?? "", "");
    expect(outside).not.toMatch(/G2|G2-PII-03|ui\/Form\.tsx/);
    click([...row.querySelectorAll("button")].find((b) => b.textContent === "Подробнее") ?? null);
    const opened = q(el, "gate-report-specialist-G2") as HTMLDetailsElement;
    expect(opened.tagName).toBe("DETAILS");
    expect(opened.open).toBe(false);
    expect(opened.textContent).toContain("Подробнее для специалиста");
    expect(opened.textContent).toContain("G2-PII-03 fail ui/Form.tsx:12");
    const visible = (row.textContent ?? "").replace(opened.textContent ?? "", "");
    expect(visible).toContain("Нет согласия на обработку данных");
    expect(visible).not.toMatch(/G2-PII-03|ui\/Form\.tsx|G2\b/);
  });
});

describe("/admin «Обращения»", () => {
  const VERIFIED = { isStaff: true, mfaEnrolled: true, mfaVerifiedUntil: "2026-10-05T22:00:00Z" };
  const item = (over: Partial<SupportRequestItem> = {}): SupportRequestItem => ({
    id: "s1",
    orgId: ORG,
    orgName: "Пекарня",
    email: "anna@bakery.example",
    systemId: SYS,
    systemName: "Запись в салон",
    screen: "system",
    text: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
    wantsTeam: true,
    createdAt: "2026-10-05T07:00:00Z",
    replyBy: "2020-01-01T09:00:00Z",
    answeredAt: null,
    ...over,
  });

  test("list with the client's address and system; text as text; overdue; «отвечено» marks it", async () => {
    let items = [item()];
    const mark = vi.fn(async (id: string, answered: boolean) => {
      items = items.map((x) =>
        x.id === id ? { ...x, answeredAt: answered ? "2026-10-05T08:00:00Z" : null } : x,
      );
      return { id, answeredAt: answered ? "2026-10-05T08:00:00Z" : null };
    });
    const el = app(
      baseApi({
        adminSession: (async () => VERIFIED) as unknown as ApiClient["adminSession"],
        adminListAbuseReports: async () => ({ items: [] }),
        adminListSupportRequests: (async () => ({
          items,
        })) as unknown as ApiClient["adminListSupportRequests"],
        adminMarkSupportRequest: mark as unknown as ApiClient["adminMarkSupportRequest"],
      }),
      "/admin?tab=support",
    );
    await waitFor(() => q(el, "admin-support-row") !== null);
    expect(q(el, "support-open")).toBeNull();
    const row = q(el, "admin-support-row") as HTMLElement;
    expect(row.textContent).toContain("anna@bakery.example");
    expect(row.textContent).toContain("Запись в салон");
    expect(row.textContent).toContain("просит доделать");
    expect(row.textContent).toContain("просрочено");
    expect(q(el, "admin-support-text")?.textContent).toContain("<script>alert(2)</script>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    await act(async () => {
      q(el, "admin-support-answered")?.click();
    });
    expect(mark).toHaveBeenCalledWith("s1", true);
    await waitFor(() => q(el, "admin-support-row") === null);
  });
});
