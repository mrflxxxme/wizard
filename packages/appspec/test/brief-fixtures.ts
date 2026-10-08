// V3-02 test briefs, built by code: a dental clinic with booking (every section filled), a shop and the minimal one.
import type { BriefScenario, SystemBriefInput } from "../src/index.js";

type ScenarioInput = Omit<BriefScenario, "priority" | "then"> & { priority?: BriefScenario["priority"] };

/** A scenario «Когда <when>, система <steps>» (the contract field `then` is set here once). */
export function scenario(
  s: ScenarioInput,
  steps: string[],
): NonNullable<SystemBriefInput["scenarios"]>[number] {
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
  return { ...s, then: steps };
}

export function dentalBrief(): SystemBriefInput {
  return {
    goals: [
      { id: "g_leads", text: "Получать записи на приём с сайта", success: "Не меньше 30 записей в месяц" },
      { id: "g_no_shows", text: "Меньше неявок", success: "Неявок меньше 10 %" },
    ],
    audience: "Жители района 25–55 лет, семьи с детьми; записываются с телефона вечером",
    scenarios: [
      scenario(
        { id: "s_book", actor: "visitor", when: "посетитель выбирает услугу и время", goalId: "g_leads" },
        ["создаёт запись", "присылает подтверждение в Telegram"],
      ),
      scenario(
        { id: "s_remind", actor: "system", when: "до приёма остаётся 24 часа", goalId: "g_no_shows" },
        ["напоминает клиенту"],
      ),
      scenario({ id: "s_confirm", actor: "staff", when: "администратор подтверждает запись" }, [
        "меняет статус записи",
        "уведомляет врача",
      ]),
      scenario(
        { id: "s_report", actor: "owner", when: "владелец открывает отчёт за неделю", priority: "should" },
        ["показывает записи и неявки по дням"],
      ),
    ],
    roles: [
      { id: "admin", name: "Администратор", can: ["полный доступ"] },
      { id: "doctor", name: "Врач", can: ["видит свои записи", "отмечает неявку"] },
    ],
    data: [
      {
        entity: "Клиент",
        fields: [{ name: "Имя", pii: true }, { name: "Телефон", pii: true }, { name: "Комментарий" }],
        retention: "3 года после последнего визита",
      },
      { entity: "Запись", fields: [{ name: "Дата и время" }, { name: "Услуга" }], retention: "3 года" },
      {
        entity: "Услуга",
        fields: [{ name: "Название" }, { name: "Цена" }],
        retention: "пока действует система",
      },
    ],
    integrations: [
      { id: "telegram", name: "Telegram", direction: "out", secretRef: "secret://telegram_bot" },
      { id: "yookassa", name: "ЮKassa", direction: "out", contractRef: "contracts/yookassa.openapi.json" },
      { id: "crm_in", name: "Сайт партнёра", direction: "in", contractRef: "openapi.json" },
    ],
    design: { archetype: "warm_clinic", pinned: false, references: ["https://example.com/clinic"] },
    outOfScope: [{ text: "Мобильное приложение", substitute: "Сайт, удобный с телефона" }],
    assumptions: [
      { text: "Оплата на месте, онлайн-оплата позже", source: "owner_skip" },
      { text: "Один филиал", source: "default" },
    ],
    qa: [
      {
        q: "Как клиенты записываются сейчас?",
        a: "По телефону",
        recommended: "Онлайн-запись с выбором времени",
        chosen: "custom",
      },
      { q: "Нужны напоминания?", a: "Да, за сутки", recommended: "Да, за сутки", chosen: "recommended" },
    ],
    capability: [
      { requirement: "Онлайн-запись", level: "modules" },
      { requirement: "Отчёт по неявкам", level: "custom" },
      { requirement: "Интеграция с медицинской МИС", level: "not_yet" },
    ],
  };
}

export function shopBrief(): SystemBriefInput {
  return {
    goals: [{ id: "g_sales", text: "Продавать чай онлайн", success: "50 заказов в месяц" }],
    audience: "Любители чая по всей России",
    scenarios: [
      scenario(
        { id: "s_cart", actor: "visitor", when: "покупатель кладёт товар в корзину", goalId: "g_sales" },
        ["сохраняет корзину"],
      ),
      scenario({ id: "s_pay", actor: "client", when: "клиент оплачивает заказ", goalId: "g_sales" }, [
        "проводит оплату",
        "отправляет чек по 54-ФЗ",
      ]),
      scenario({ id: "s_ship", actor: "staff", when: "менеджер передаёт заказ в доставку" }, [
        "создаёт отправление в СДЭК",
      ]),
    ],
    roles: [{ id: "manager", name: "Менеджер", can: ["обрабатывает заказы", "меняет остатки товаров"] }],
    data: [
      {
        entity: "Заказ",
        fields: [{ name: "Адрес доставки", pii: true }, { name: "Сумма" }],
        retention: "5 лет",
      },
      { entity: "Товар", fields: [{ name: "Название" }, { name: "Остаток" }], retention: "бессрочно" },
    ],
    integrations: [
      { id: "yookassa", name: "ЮKassa", direction: "out", secretRef: "secret://yookassa" },
      { id: "cdek", name: "СДЭК", direction: "out" },
    ],
    design: { references: [] },
  };
}

/** The minimal brief: nothing filled (the interview starts from it). */
export const minimalBrief = (): SystemBriefInput => ({});
