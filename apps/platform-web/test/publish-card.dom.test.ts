// @vitest-environment happy-dom
// S5 publish card: every publishBlockers code of api.yaml has a Russian hint (platform-screens.yaml S5), including
// PHONE_LOGIN_PLAN_REQUIRED (F4), PLAN_LIMIT (FU-6) and ORG_SUSPENDED; «Оспорить» on a G2 antifraud stop (abuse.yaml#rescan).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RoleSpec, WzProvider } from "@wizard/ui-kit";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import type { GateReport } from "../src/api/types.js";
import { ru } from "../src/i18n/ru.js";
import { GateReportView, PublishCard, publishBlockers } from "../src/screens/workspace/GateReport.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPEC: RoleSpec = {
  app: { name: "Wizard" },
  role: null,
  roles: [],
  entities: [],
  permissions: [],
  pages: [],
  theme: { accent: "#2F46D8", font: "Onest", radius: 8, density: "regular", mode: "light" },
  loginMethods: [],
};

let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

function apiBlockerCodes(): string[] {
  const doc = parse(readFileSync(join(import.meta.dirname, "../../../specs/platform/api.yaml"), "utf8"));
  const text = JSON.stringify(doc);
  const m = /"publishBlockers":\{"type":"array","items":\{"type":"string","enum":(\[[^\]]*\])/.exec(text);
  if (!m?.[1]) throw new Error("publishBlockers enum not found in api.yaml");
  return JSON.parse(m[1]) as string[];
}

test("every api.yaml publishBlockers code has a Russian hint", () => {
  const codes = apiBlockerCodes();
  expect(codes).toContain("PHONE_LOGIN_PLAN_REQUIRED");
  for (const code of codes) {
    const [text] = publishBlockers([code], []);
    expect(text, code).not.toBe(code);
    expect(text, code).toMatch(/[А-Яа-яЁё]/);
  }
});

test("PublishCard shows the phone-login and plan-limit hints", () => {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      h(
        WzProvider,
        { spec: SPEC, applyTheme: false },
        h(PublishCard, {
          systemId: "00000000-0000-4000-8000-000000000001",
          slug: "forum",
          blockers: publishBlockers(["PHONE_LOGIN_PLAN_REQUIRED", "PLAN_LIMIT"], []),
          codes: ["PHONE_LOGIN_PLAN_REQUIRED", "PLAN_LIMIT"],
          prodRevision: null,
          prodUrl: null,
          revision: 1,
          showSubmit: true,
          running: false,
          busy: false,
          error: null,
          onEdit: () => {},
          onPublish: () => {},
        }),
      ),
    );
  });
  const shown = [...container.querySelectorAll('[data-testid="publish-blocker"]')].map((e) => e.textContent);
  expect(shown).toEqual([
    "Вход по телефону доступен на тарифах Старт и Бизнес",
    "Лимит опубликованных систем тарифа",
  ]);
  expect(ru.publish.blockers.PHONE_LOGIN_PLAN_REQUIRED).toBe(shown[0]);
  act(() => root.unmount());
});

const g2 = (checks: GateReport["checks"]): GateReport => ({
  level: "G2",
  passed: !checks.some((c) => c.status === "fail"),
  specVersion: 4,
  checks,
});

function renderReports(reports: GateReport[], send?: (revision: number, text: string) => Promise<string>) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      h(
        WzProvider,
        { spec: SPEC, applyTheme: false },
        h(GateReportView, { reports, revision: 4, ...(send ? { dispute: { send } } : {}) }),
      ),
    );
  });
  return { el: container, root };
}

const tid = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

test("«Оспорить»: only for an owner on a failed G2 antifraud blocker; sends revision and comment", async () => {
  const send = vi.fn(async () => ru.gates.disputeSent);
  const af = {
    id: "G2-AF-01",
    severity: "blocker",
    status: "fail",
    message_ru: "Публикация приостановлена",
  } as const;
  // Not an antifraud stop (G2-PII), or no handler (editor) → no button.
  const pii = renderReports(
    [g2([{ id: "G2-PII-01", severity: "blocker", status: "fail", message_ru: "ПДн" }])],
    send,
  );
  expect(tid(pii.el, "gate-dispute")).toBeNull();
  act(() => pii.root.unmount());
  container?.remove();
  const editor = renderReports([g2([af])]);
  expect(tid(editor.el, "gate-dispute")).toBeNull();
  act(() => editor.root.unmount());
  container?.remove();

  const { el, root } = renderReports([g2([af])], send);
  act(() => tid(el, "gate-dispute")?.click());
  const area = tid(el, "gate-dispute-text") as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      area,
      " Это поле для промокода ",
    );
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    tid(el, "gate-dispute-send")?.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(send).toHaveBeenCalledWith(4, "Это поле для промокода");
  expect(tid(el, "gate-dispute-sent")?.textContent).toBe(ru.gates.disputeSent);
  act(() => root.unmount());
});

test("ORG_SUSPENDED has its Russian blocker hint", () => {
  expect(publishBlockers(["ORG_SUSPENDED"], [])).toEqual([ru.publish.blockers.ORG_SUSPENDED]);
});
