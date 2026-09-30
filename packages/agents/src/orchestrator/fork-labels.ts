// Short Russian labels of the fork taxonomy for the S2 panel «Как я понял задачу» (payload.analysis.forks):
// a noun-phrase title per fork and a short label per option. Completeness is tested against FORKS.
import type { ForkId } from "./taxonomy.js";

export interface ForkLabels {
  title: string;
  options: Record<string, string>;
}

export const FORK_LABELS: Record<ForkId, ForkLabels> = {
  "F-ACCESS": {
    title: "Доступ клиентов",
    options: { public_form: "форма без входа", login_required: "со входом", staff_only: "только сотрудники" },
  },
  "F-LOGIN": {
    title: "Способ входа",
    options: {
      email: "код на почту",
      telegram: "Telegram",
      email_or_telegram: "почта или Telegram",
      phone: "код по СМС",
      phone_or_email: "СМС или почта",
    },
  },
  "F-STAFF": {
    title: "Команда в системе",
    options: {
      single_admin: "один администратор",
      admin_manager: "администратор и менеджеры",
      admin_manager_moderator: "администратор, менеджеры и модераторы",
    },
  },
  "F-VISIBILITY": {
    title: "Кто что видит",
    options: {
      all_see_all: "все видят всё",
      assigned_only: "только свои записи",
      by_department: "по отделам",
    },
  },
  "F-APPROVAL": {
    title: "Подтверждение заявок",
    options: { auto: "автоматически", manual: "вручную", rule_based: "по правилам" },
  },
  "F-STATUSES": {
    title: "Статусы",
    options: { simple_3: "новая → в работе → готово", pipeline_board: "доска этапов", custom: "свои этапы" },
  },
  "F-PAYMENT": {
    title: "Оплата",
    options: {
      none: "без оплаты",
      yookassa_full: "полностью онлайн",
      yookassa_prepay: "предоплата онлайн",
      invoice_manual: "по счёту",
    },
  },
  "F-NOTIFY": {
    title: "Уведомления",
    options: {
      email: "почта",
      telegram: "Telegram",
      email_and_telegram: "почта и Telegram",
      none: "без уведомлений",
    },
  },
  "F-ASSIGN": {
    title: "Назначение исполнителя",
    options: { manual: "вручную", round_robin: "по очереди", self_pick: "исполнитель берёт сам" },
  },
  "F-BOOKING": {
    title: "Запись по времени",
    options: {
      fixed_slots: "фиксированные слоты",
      specialist_schedule: "расписание специалистов",
      requests_only: "только заявки",
    },
  },
  "F-INVENTORY": {
    title: "Остатки",
    options: { no: "не учитываем", simple_stock: "простой учёт", reserve_on_order: "резерв при заказе" },
  },
  "F-REPORTS": {
    title: "Отчёты",
    options: { lists_export: "списки и выгрузка", summary_dashboard: "сводка", both: "списки и сводка" },
  },
  "F-IMPORT": {
    title: "Начальные данные",
    options: { empty: "с нуля", import_table: "импорт таблицы" },
  },
  "F-RETENTION": {
    title: "Хранение данных людей",
    options: { d30_after_event: "30 дней после события", y1: "1 год", y3: "3 года" },
  },
  "F-EV-TICKETS": {
    title: "Типы билетов",
    options: {
      single_free: "один бесплатный",
      types_with_quotas: "типы с лимитами",
      types_quotas_price_tiers: "типы, лимиты и ценовые волны",
    },
  },
  "F-EV-CHECKIN": {
    title: "Проверка на входе",
    options: { list_only: "по списку", qr_online: "QR онлайн", qr_offline_scanner: "QR-сканер без сети" },
  },
  "F-EV-PROGRAM": {
    title: "Программа",
    options: {
      none: "без программы",
      schedule_only: "расписание",
      schedule_with_signup: "расписание с записью",
    },
  },
  "F-EV-SPEAKERS": {
    title: "Отбор докладов",
    options: { manual_list: "список вручную", call_for_papers_moderation: "заявки с модерацией" },
  },
  "F-EV-STAY": {
    title: "Расселение",
    options: {
      none: "не нужно",
      room_assignment: "распределение номеров",
      room_requests: "заявки на номера",
    },
  },
  "F-EV-ZONES": {
    title: "Зоны доступа",
    options: { none: "без зон", zones_by_ticket_type: "по типу билета" },
  },
  "F-EV-GROUPS": {
    title: "Групповая регистрация",
    options: { individual: "поодиночке", group_by_contact: "группой", company_quota: "квоты компаний" },
  },
  "F-GD-CATALOG": {
    title: "Каталог",
    options: {
      fixed_items: "готовые позиции",
      items_with_options: "позиции с опциями",
      calculator_formula: "калькулятор цены",
    },
  },
  "F-GD-PRICING": {
    title: "Цены",
    options: {
      single_price: "одна цена",
      per_client_pricelist: "прайс по клиентам",
      volume_discounts: "скидки за объём",
    },
  },
  "F-GD-CAPACITY": {
    title: "Лимит заказов",
    options: {
      no_limit: "без лимита",
      daily_capacity: "лимит в день",
      preorder_batches: "партии по предзаказу",
    },
  },
  "F-GD-DELIVERY": {
    title: "Получение заказа",
    options: { pickup: "самовывоз", delivery: "доставка", both: "самовывоз и доставка" },
  },
  "F-GD-PREPAY": {
    title: "Предоплата",
    options: { full: "полная", fixed_percent: "часть заранее", on_pickup: "при получении" },
  },
};

/** Short title of a fork ("Типы билетов"); unknown ids come back as is. */
export function forkTitle(forkId: string): string {
  return FORK_LABELS[forkId as ForkId]?.title ?? forkId;
}

/** Short label of a fork option ("типы с лимитами"), undefined for unknown ids. */
export function forkOptionLabel(forkId: string, optionId: string): string | undefined {
  return FORK_LABELS[forkId as ForkId]?.options[optionId];
}
