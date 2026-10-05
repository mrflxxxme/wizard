// @vitest-environment happy-dom
// M0-30 (L4-20, F2): S1 and S3 show the build model from OrgSettings.buildModelLabel — with T0 by default
// «Сборка: модели в РФ» (no scrub wording), with T1 the model label and «ПДн удаляются».
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ComponentProps, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import type { OrgSettings, SystemCard } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { RU_BUILD_LABEL } from "../src/i18n/ru.js";
import { Start } from "../src/screens/Start.js";
import { CardView } from "../src/screens/workspace/CardView.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function mount(node: ReturnType<typeof h>): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

function fakeApi(settings: OrgSettings | null): ApiClient {
  return {
    listSystems: async () => ({ items: [], nextCursor: null }),
    getOrgSettings: async () => {
      if (!settings) throw new Error("404");
      return settings;
    },
  } as unknown as ApiClient;
}

/** PlatformProvider around a screen; children go as the createElement argument (props type needs a cast). */
const platform = (settings: OrgSettings | null, child: ReactElement) =>
  h(PlatformProvider, { api: fakeApi(settings) } as ComponentProps<typeof PlatformProvider>, child);

const text = (el: HTMLElement, id: string): string =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function startScreen(settings: OrgSettings | null): Promise<HTMLDivElement> {
  const el = mount(platform(settings, h(Start)));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return el;
}

const card: SystemCard = { cardVersion: 1, kind: "create", estimate: {}, cap: { credits: 40 } };
const cardScreen = (label: string | undefined) =>
  mount(
    platform(
      null,
      h(CardView, {
        card,
        changed: new Set<never>(),
        buildModelLabel: label,
        busy: false,
        error: null,
        onBuild: () => {},
        onEdit: () => {},
      }),
    ),
  );

describe("build model label on S1/S3", () => {
  test("T0 by default: S1 «Сборка: модели в РФ» without scrub wording", async () => {
    const el = await startScreen({ ruOnly: false, buildModelLabel: RU_BUILD_LABEL, t1Restricted: false });
    const policy = text(el, "start-policy");
    expect(policy).toContain("Сборка: модели в РФ");
    expect(policy).not.toContain("личные данные убираем");
  });

  test("T0 by default: S3 footer «Сборка: модели в РФ»", () => {
    const cap = text(cardScreen(RU_BUILD_LABEL), "card-cap");
    expect(cap).toContain("Сборка: модели в РФ");
    expect(cap).not.toContain("без личных данных");
  });

  test("T1 by default: S1/S3 show the model label and the scrub wording", async () => {
    const el = await startScreen({ ruOnly: false, buildModelLabel: "GLM-5.3", t1Restricted: false });
    expect(text(el, "start-policy")).toContain("Сборка: GLM-5.3, личные данные убираем до отправки");
    act(() => root?.unmount());
    root = undefined;
    expect(text(cardScreen("GLM-5.3"), "card-cap")).toContain("Сборка: GLM-5.3, без личных данных");
  });

  test("no settings (API error) → no model name at all", async () => {
    const el = await startScreen(null);
    expect(text(el, "start-policy")).not.toContain("Сборка:");
    expect(text(el, "start-policy")).toContain("Личные данные убираем до отправки моделям");
  });

  test("the UI constant equals the label platform-api sends (@wizard/llm RU_BUILD_LABEL)", () => {
    const src = readFileSync(join(import.meta.dirname, "../../../packages/llm/src/registry.ts"), "utf8");
    expect(src).toContain(`export const RU_BUILD_LABEL = "${RU_BUILD_LABEL}";`);
  });
});
