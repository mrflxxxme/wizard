// B2-44: the short site name of a compiled system — the header, <title>, the cabinet and the e-mails show it; the raw
// brief («…, нужен сайт где люди…», cut at 60 characters) never becomes the name.

import type { SystemPlan } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { compilePlan, DEFAULT_SITE_NAME, MAX_SITE_NAME, planSiteName, siteName } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

/** Raw briefs of the final D76 measurement (07.10.2026), cut at 60 characters as the old system names were. */
const D76_BRIEFS: readonly [string, string][] = [
  ["Стоматология в Казани, нужен сайт где люди оставляют заявку", "Стоматология в Казани"],
  ["сайт для ремонта квартир под ключ, калькулятор не надо, прос", "Сайт для ремонта квартир под ключ"],
  [
    "аренда переговорки в коворкинге почасово, чтобы не было пере",
    "Аренда переговорки в коворкинге почасово",
  ],
  ["CRM для небольшого агентства недвижимости: клиенты, объекты,", "CRM для небольшого агентства"],
];

const FORBIDDEN = /нужен сайт|калькулятор не надо|чтобы|[,.:;!?\-–—\s]$/u;

describe("siteName", () => {
  test.each(D76_BRIEFS)("%s → %s", (brief, name) => {
    const out = siteName(brief);
    expect(out).toBe(name);
    expect(out).not.toMatch(FORBIDDEN);
    expect(out.length).toBeLessThanOrEqual(MAX_SITE_NAME);
    // Every word is whole: the name is a prefix of the brief's words.
    const words = brief.toLowerCase().split(/[\s,:]+/u);
    for (const w of out.toLowerCase().split(" ")) expect(words).toContain(w);
  });

  test("niches of the planner become names with an upper-case first letter", () => {
    expect(siteName("стоматологическая клиника")).toBe("Стоматологическая клиника");
    expect(siteName("агентство недвижимости")).toBe("Агентство недвижимости");
    expect(siteName("фитнес-студия")).toBe("Фитнес-студия");
    expect(siteName("CRM для риелторов")).toBe("CRM для риелторов");
  });

  test("a wish clause without a comma, a leading wish, quotes and a dash clause are dropped", () => {
    expect(siteName("Стоматология в Казани нужен сайт где люди оставляют заявку")).toBe(
      "Стоматология в Казани",
    );
    expect(siteName("Хочу онлайн-запись в барбершоп «Борода» — чтобы клиенты")).toBe(
      "Онлайн-запись в барбершоп Борода",
    );
    expect(siteName("  кофейня «Зерно».  Работаем с 8 утра")).toBe("Кофейня Зерно");
  });

  test("≤ 40 characters cut on a word boundary, never ending with a preposition", () => {
    const out = siteName("стоматологическая клиника в Казани с онлайн-записью и личным кабинетом");
    expect(out).toBe("Стоматологическая клиника в Казани");
    expect(siteName("ремонт квартир и домов под ключ в Москве и области недорого")).toBe(
      "Ремонт квартир и домов под ключ в Москве",
    );
    expect(siteName("ремонт квартир и домов под ключ в Москве и области", 33)).toBe(
      "Ремонт квартир и домов под ключ",
    );
    expect(siteName("а".repeat(60))).toHaveLength(MAX_SITE_NAME);
  });

  test("nothing usable → empty; the plan name falls back to the default", () => {
    expect(siteName(" , . ")).toBe("");
    expect(planSiteName({ niche: "..." })).toBe(DEFAULT_SITE_NAME);
    expect(planSiteName({ niche: "барбершоп, стрижки и бритьё" })).toBe("Барбершоп");
  });
});

describe("compilePlan names the system", () => {
  const niche = "стоматология в Казани, нужен сайт где люди оставляют заявку";

  test("from the plan's niche without appName, by appName when the owner named it", () => {
    const plan = { ...landingLeadsPlan(), niche };
    const auto = compilePlan(plan, testRegistry());
    expect(auto.ok && auto.spec.app.name).toBe("Стоматология в Казани");
    const named = compilePlan(plan, testRegistry(), { appName: "Улыбка" });
    expect(named.ok && named.spec.app.name).toBe("Улыбка");
  });

  test("a system without a landing is named from its niche the same way", () => {
    const { landing: _l, ...rest } = { ...landingLeadsPlan(), niche };
    const plan = {
      ...rest,
      goals: rest.goals.filter((g) => g.id === "leads"),
      modules: rest.modules.filter((m) => m.id !== "landing"),
    } as SystemPlan;
    const auto = compilePlan(plan, testRegistry());
    expect(auto.ok, JSON.stringify(!auto.ok && auto.errors)).toBe(true);
    expect(auto.ok && auto.spec.app.name).toBe("Стоматология в Казани");
  });
});
