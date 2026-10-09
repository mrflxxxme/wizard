// V3-03 acceptance 3: «Карта возможностей» by code on four briefs of the v3 classes — business site, booking, CRM,
// shop. Every requirement (scenario, integration, extra requirement) gets «на проверенных модулях», «своим кодом, с
// пометкой» or «пока не умею — в запросы на развитие»; the shop has no modules yet, so its cart, payment, delivery,
// stock and receipts are «не умею» with a replacement. The share of «не умею» is counted per month for /admin.
import { emptyBrief, type SystemBrief, validateBrief } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  applyBriefPatch,
  type BriefPatch,
  blockingGaps,
  capabilityCounts,
  capabilityMap,
  notYetShareByMonth,
  refreshCapability,
  requirementLevel,
} from "../../src/interview-v3/index.js";

function brief(patch: BriefPatch): SystemBrief {
  const r = applyBriefPatch(emptyBrief(), patch, { assumptionSource: "default" });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.brief;
}

const sc = (
  actor: "visitor" | "client" | "staff" | "owner" | "system",
  when: string,
  then: string[],
  moduleHint?: string,
) => ({
  actor,
  when,
  then,
  ...(moduleHint ? { moduleHint } : {}),
  priority: "must" as const,
});

const BRIEFS = {
  site: brief({
    goals: [{ text: "Клиенты оставляют заявки на замер", success: "Заявки приходят владельцу" }],
    scenarios: [
      sc("visitor", "посетитель открывает сайт", ["показывает услуги и портфолио работ"]),
      sc("visitor", "посетитель оставляет заявку на замер", ["сохраняет заявку", "сообщает владельцу"]),
      sc("owner", "владелец пишет статью в блог", ["публикует статью на странице блога"]),
    ],
  }),
  booking: brief({
    scenarios: [
      sc("client", "клиент выбирает мастера и свободное время", [
        "записывает клиента",
        "присылает подтверждение",
      ]),
      sc("system", "до визита остаются сутки", ["присылает клиенту напоминание"]),
      sc("client", "клиент входит в личный кабинет", ["показывает его записи"]),
    ],
    integrations: [{ name: "Telegram для уведомлений мастерам", direction: "out" }],
  }),
  crm: brief({
    scenarios: [
      sc("staff", "менеджер открывает карточку клиента", ["показывает историю обращений и заметки"]),
      sc("staff", "менеджер ведёт сделку", ["показывает сделки по этапам", "напоминает о задачах"]),
      sc("owner", "владелец открывает отчёт", ["показывает сделки и выручку за месяц"]),
    ],
  }),
  shop: brief({
    scenarios: [
      sc("visitor", "покупатель смотрит каталог", ["показывает товары с ценами"]),
      sc("visitor", "покупатель кладёт товар в корзину и оплачивает онлайн", ["оформляет заказ"]),
      sc("system", "заказ оплачен", ["передаёт посылку в СДЭК", "пробивает чек по 54-ФЗ"]),
    ],
    integrations: [{ name: "ЮKassa", direction: "out" }],
  }),
};

describe("capability map on the four v3 classes", () => {
  test("business site: landing and leads on modules, the blog as own code", () => {
    const { verdicts } = capabilityMap(BRIEFS.site);
    expect(verdicts.map((v) => [v.level, v.module ?? null])).toEqual([
      ["modules", "landing"],
      ["modules", "leads"],
      ["custom", null],
    ]);
  });

  test("booking: booking, reminders, the client's cabinet and Telegram — all on proven modules", () => {
    const { verdicts, capability } = capabilityMap(BRIEFS.booking);
    expect(verdicts.map((v) => v.module)).toEqual(["booking", "notify", "visitor_cabinet", "notify"]);
    expect(capabilityCounts(capability)).toMatchObject({ modules: 4, custom: 0, not_yet: 0, total: 4 });
  });

  test("CRM: clients with history, deals, reports — on proven modules", () => {
    const { verdicts } = capabilityMap(BRIEFS.crm);
    expect(verdicts.map((v) => [v.level, v.module])).toEqual([
      ["modules", "client_card"],
      ["modules", "deals"],
      ["modules", "reports"],
    ]);
  });

  test("shop: the catalog on modules; cart, online payment, delivery, receipts and ЮKassa — not yet, with a replacement", () => {
    const { verdicts, capability } = capabilityMap(BRIEFS.shop, [
      { text: "Учёт остатков на складе" },
      { text: "Блог о чае" },
    ]);
    expect(verdicts.map((v) => [v.level, v.module ?? v.category])).toEqual([
      ["modules", "catalog"],
      ["not_yet", "payments"],
      ["not_yet", "integration"],
      ["not_yet", "payments"],
      ["not_yet", "other"],
      ["custom", undefined],
    ]);
    expect(verdicts.filter((v) => v.level === "not_yet").every((v) => (v.substitute ?? "").length > 0)).toBe(
      true,
    );
    const c = capabilityCounts(capability);
    expect(c.not_yet + c.custom).toBeGreaterThan(0);
    expect(c).toMatchObject({ modules: 1, custom: 1, not_yet: 4, total: 6 });
  });

  test("refreshCapability writes the map into the brief and every «не умею» into «Не входит» with the replacement; the brief stays valid", () => {
    const b = structuredClone(BRIEFS.shop);
    refreshCapability(b, []);
    expect(b.capability.map((c) => c.level)).toEqual(["modules", "not_yet", "not_yet", "not_yet"]);
    expect(b.outOfScope.map((o) => o.text)).toEqual([
      expect.stringMatching(/^Пока не умею: Когда покупатель кладёт товар в корзину/),
      expect.stringMatching(/^Пока не умею: Когда заказ оплачен/),
      "Пока не умею: Интеграция: ЮKassa",
    ]);
    expect(b.outOfScope.every((o) => o.substitute)).toBe(true);
    refreshCapability(b, []);
    expect(b.outOfScope).toHaveLength(3);
    expect(validateBrief(b).ok).toBe(true);
  });

  test("rules: not-yet beats a module hint; own-code kinds beat the hint; an unknown hint is ignored", () => {
    expect(
      requirementLevel({ text: "Покупатель оплачивает заказ картой на сайте", moduleHint: "catalog" }).level,
    ).toBe("not_yet");
    expect(requirementLevel({ text: "Статьи в блоге", moduleHint: "landing" }).level).toBe("custom");
    expect(requirementLevel({ text: "Что-то своё", moduleHint: "booking" })).toEqual({
      level: "modules",
      module: "booking",
    });
    expect(requirementLevel({ text: "Что-то своё", moduleHint: "no_such_module" }).level).toBe("custom");
    expect(requirementLevel({ text: "Обмен заказами с 1С" }).category).toBe("integration");
    expect(requirementLevel({ text: "Мобильное приложение в App Store" }).category).toBe("mobile");
  });

  test("data blocks only when modules keep business records (the landing's photos do not count)", () => {
    expect(blockingGaps(BRIEFS.site).map((g) => g.topic)).toEqual(["data", "roles"]);
    const onlySite = brief({
      goals: [{ text: "Рассказать о студии", success: "Посетитель понимает, что мы делаем" }],
      scenarios: [sc("visitor", "посетитель открывает сайт", ["показывает услуги"])],
    });
    expect(blockingGaps(onlySite).map((g) => g.topic)).toEqual(["roles"]);
  });
});

describe("the monthly share of «не умею» (/admin)", () => {
  test("months ascending, briefs and requirements summed, share with 3 decimals", () => {
    const shop = capabilityMap(BRIEFS.shop).capability;
    const crm = capabilityMap(BRIEFS.crm).capability;
    const rows = notYetShareByMonth([
      { createdAt: "2026-11-03T10:00:00Z", capability: crm },
      { createdAt: "2026-10-20T10:00:00Z", capability: shop },
      { createdAt: "2026-10-21T10:00:00Z", capability: crm },
      { createdAt: new Date("2026-11-30T23:00:00Z"), capability: [] },
    ]);
    expect(rows).toEqual([
      { month: "2026-10", briefs: 2, requirements: 7, notYet: 3, share: 0.429 },
      { month: "2026-11", briefs: 2, requirements: 3, notYet: 0, share: 0 },
    ]);
  });
});
