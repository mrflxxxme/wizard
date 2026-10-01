// G0 check catalog = specs/quality/gates.yaml#G0.checks (id, severity, since); test/catalog.test.ts keeps it in sync.
import type { Milestone, Severity } from "./types.js";

export interface CheckDef {
  id: string;
  severity: Severity;
  since?: Milestone;
  /** Short Russian title shown for a passing check. */
  title_ru: string;
}

export const G0_TIME_BUDGET_MS = 60_000;
export const G0_TARGET_MS = 20_000;

export const G0_CHECKS: readonly CheckDef[] = [
  { id: "G0-SPEC-01", severity: "blocker", title_ru: "Описание системы соответствует схеме" },
  { id: "G0-SPEC-02", severity: "blocker", title_ru: "Описание системы непротиворечиво" },
  { id: "G0-SPEC-03", severity: "blocker", title_ru: "Все страницы и функции из описания есть в коде" },
  { id: "G0-SPEC-04", severity: "warning", title_ru: "В коде нет неиспользуемых файлов" },
  { id: "G0-SPEC-05", severity: "blocker", title_ru: "Роли, вход и адреса страниц настроены безопасно" },
  { id: "G0-SPEC-06", severity: "blocker", title_ru: "Поля-файлы не требуют загрузки от пользователей" },
  { id: "G0-MIG-01", severity: "blocker", title_ru: "Изменения данных можно применить" },
  { id: "G0-MIG-02", severity: "blocker", title_ru: "Структура данных и права применяются к базе" },
  {
    id: "G0-IDX-01",
    severity: "blocker",
    title_ru: "Запросы к данным идут по индексам и в пределах лимитов",
  },
  { id: "G0-FN-01", severity: "blocker", title_ru: "Функции объявлены правильно и проверяют аргументы" },
  { id: "G0-TS-01", severity: "blocker", title_ru: "Код проходит проверку типов" },
  { id: "G0-LINT-01", severity: "warning", since: "M1", title_ru: "Код проходит линтер" },
  { id: "G0-BUILD-01", severity: "blocker", title_ru: "Система собирается" },
  { id: "G0-IMP-01", severity: "blocker", title_ru: "Код подключает только разрешённые модули" },
  { id: "G0-SEC-01", severity: "blocker", title_ru: "В коде нет запрещённых возможностей" },
  { id: "G0-A11Y-01", severity: "warning", since: "M1", title_ru: "Интерфейс доступен" },
  { id: "G0-I18N-01", severity: "warning", since: "M1", title_ru: "Тексты интерфейса на русском" },
  { id: "G0-PH-01", severity: "warning", since: "M1", title_ru: "В коде нет заглушек персональных данных" },
  { id: "G0-DATA-01", severity: "warning", since: "M1", title_ru: "В интерфейсе нет выдуманных данных" },
];

export const G1_TIME_BUDGET_MS = 120_000;

// gates.yaml#G1.checks. PC- and SC- entries of a report carry the severity of G1-PERM / G1-AC.
export const G1_CHECKS: readonly CheckDef[] = [
  { id: "G1-PERM", severity: "blocker", title_ru: "Права ролей работают так, как описано" },
  { id: "G1-AC", severity: "blocker", title_ru: "Сценарии приёмки выполняются" },
  { id: "G1-AC-COVER", severity: "blocker", title_ru: "Каждый критерий приёмки проверяется автоматически" },
  { id: "G1-FN-01", severity: "warning", title_ru: "Публичные запросы отвечают без ошибок сервера" },
  {
    id: "G1-RENDER-01",
    severity: "blocker",
    since: "M1",
    title_ru: "Страницы открываются для своих ролей без ошибок",
  },
];

export const G2_TIME_BUDGET_MS = 300_000;

// gates.yaml#G2.checks.
export const G2_CHECKS: readonly CheckDef[] = [
  { id: "G2-PERM-01", severity: "blocker", title_ru: "Права всех ролей в данных совпадают с описанием" },
  { id: "G2-PERM-02", severity: "blocker", title_ru: "База данных сама защищает записи по правам ролей" },
  { id: "G2-PERM-03", severity: "blocker", title_ru: "Пользователи не видят чужие записи" },
  { id: "G2-PERM-04", severity: "blocker", title_ru: "Скрытые поля и чужие ПДн не попадают в ответы" },
  { id: "G2-PERM-05", severity: "blocker", title_ru: "Анонимные посетители не могут менять чужие данные" },
  { id: "G2-SECRET-01", severity: "blocker", title_ru: "В коде и описании нет секретов" },
  { id: "G2-SECRET-02", severity: "blocker", title_ru: "Секреты интеграций хранятся в хранилище" },
  { id: "G2-PII-01", severity: "blocker", title_ru: "Нет особых категорий персональных данных" },
  { id: "G2-PII-02", severity: "blocker", title_ru: "Персональные данные размечены" },
  {
    id: "G2-PII-03",
    severity: "blocker",
    title_ru: "Нет сведений о здоровье, религии и других особых данных",
  },
  { id: "G2-PII-04", severity: "blocker", title_ru: "Формы с ПДн спрашивают согласие" },
  { id: "G2-PII-05", severity: "blocker", title_ru: "У персональных данных есть срок хранения" },
  { id: "G2-PII-06", severity: "blocker", title_ru: "Указаны данные оператора ПДн" },
  { id: "G2-TG-01", severity: "blocker", title_ru: "В Telegram не уходят персональные данные" },
  { id: "G2-AF-01", severity: "blocker", title_ru: "Система не собирает данные банковских карт" },
  { id: "G2-AF-02", severity: "blocker", title_ru: "Система не собирает пароли и коды подтверждения" },
  { id: "G2-AF-03", severity: "blocker", title_ru: "Система не собирает паспорта и сканы документов" },
  { id: "G2-AF-04", severity: "blocker", title_ru: "Система не выдаёт себя за известный бренд" },
  { id: "G2-AF-05", severity: "blocker", title_ru: "Данные форм не уходят на сторонние сайты" },
  { id: "G2-AF-06", severity: "blocker", title_ru: "Нет реквизитов для оплаты мимо ЮKassa" },
  { id: "G2-AF-07", severity: "blocker", title_ru: "Система не собирает ключи и секретные фразы" },
  { id: "G2-AF-08", severity: "warning", title_ru: "Риск-оценка в норме" },
  { id: "G2-AF-09", severity: "warning", title_ru: "Нет переписки между пользователями" },
];

export const CHECK_BY_ID: ReadonlyMap<string, CheckDef> = new Map(
  [...G0_CHECKS, ...G1_CHECKS, ...G2_CHECKS].map((c) => [c.id, c]),
);

const ORDER: readonly string[] = ["M0", "M1", "M2", "M3", "M4"];

/** -1 / 0 / 1; unknown milestones sort after known ones. */
export function compareMilestones(a: string, b: string): number {
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  return Math.sign((ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib));
}

export function resolveMilestone(m: string | undefined): string {
  return m ?? process.env.WIZARD_MILESTONE ?? "M0";
}
