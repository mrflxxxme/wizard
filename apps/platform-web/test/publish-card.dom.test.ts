// @vitest-environment happy-dom
// S5 publish card: every publishBlockers code of api.yaml has a Russian hint (platform-screens.yaml S5), including
// PHONE_LOGIN_PLAN_REQUIRED (F4) and PLAN_LIMIT (FU-6).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RoleSpec, WzProvider } from "@wizard/ui-kit";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import { ru } from "../src/i18n/ru.js";
import { PublishCard, publishBlockers } from "../src/screens/workspace/GateReport.js";

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
          slug: "forum",
          blockers: publishBlockers(["PHONE_LOGIN_PLAN_REQUIRED", "PLAN_LIMIT"], []),
          onEdit: () => {},
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
