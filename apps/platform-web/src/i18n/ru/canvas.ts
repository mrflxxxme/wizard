// Texts of the canvas screen (B2-25, platform-screens.yaml#canvas): plain Russian, no jargon (specs «Тексты для людей»).

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** «3 года», «1 год», «180 дней». */
export function daysText(days: number): string {
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} ${plural(y, "год", "года", "лет")}`;
  }
  if (days % 30 === 0 && days < 365) {
    const m = days / 30;
    return `${m} ${plural(m, "месяц", "месяца", "месяцев")}`;
  }
  return `${days} ${plural(days, "день", "дня", "дней")}`;
}

/** «за сутки», «за 2 ч», «за 30 мин» of a reminder offset in minutes (negative — before the time). */
export function offsetText(minutes: number): string {
  const m = Math.abs(minutes);
  if (m === 1440) return "за сутки";
  if (m % 60 === 0) return `за ${m / 60} ч`;
  return `за ${m} мин`;
}

const joinRu = (a: readonly string[]): string =>
  a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} и ${a[a.length - 1]}`;

export const canvas = {
  brand: "Born to Build",
  loading: "Открываю систему…",
  sample: "пример данных",
  frames: { site: "Сайт", cab: "Кабинет", phone: "Телефон" } as Record<string, string>,
  views: { label: "Что показать", site: "Сайт", cab: "Кабинет", phone: "Телефон" },
  theme: { toDark: "Тёмная тема", toLight: "Светлая тема" },
  xray: {
    button: "Как это работает",
    data: "Кто видит данные",
    keep: "Сколько хранятся",
    auto: "Что происходит само",
    reminder: (offsets: readonly number[]) => `Напоминание ${joinRu(offsets.map(offsetText))}`,
    goals: "Панель цели считает результат",
    scope: { all: "все", own: "только свои", some: "часть" } as Record<string, string>,
    keepFor: (label: string, days: number, mode: string) =>
      `${label} — ${daysText(days)}, потом ${mode === "anonymize" ? "обезличиваются" : "удаляются"}`,
    none: "Пока нечего показать: слой появится вместе с планом.",
    trigger: {
      on_create: (e: string) => `Новая запись: ${e.toLowerCase()}`,
      on_update: (e: string) => `Изменение: ${e.toLowerCase()}`,
      on_status: (e: string) => `Смена статуса: ${e.toLowerCase()}`,
      schedule: () => "По расписанию",
      webhook: () => "Сигнал из другого сервиса",
      manual: () => "По кнопке",
    } as Record<string, (entity: string) => string>,
  },
  chat: {
    label: "Разговор",
    start: "Расскажите о своём деле",
    custom: "Свой ответ",
    change: "Что поменять?",
    thinking: "Думаю над системой…",
    building: "Собираю систему…",
    step: (i: number, n: number) => `${i} из ${n}`,
    rest: "Остальное — по рекомендациям",
    sketchReady: "Набросал систему по вашему описанию. Уточню пару деталей.",
    answered: (label: string) => `Учёл: ${label.toLowerCase()}`,
    piiShort: "Личные данные из сообщения скрыты и не попадут к моделям.",
  },
  plan: {
    title: "План готов",
    goals: (n: number) => `${n} ${plural(n, "цель", "цели", "целей")}`,
    blocks: (n: number) => `${n} ${plural(n, "блок", "блока", "блоков")}`,
    out: (n: number) => `не входит: ${n}`,
    build: "Собрать",
    changed: "План изменён",
    rebuild: "Пересобрать",
    approving: "Запускаю сборку…",
    errors: "В плане есть ошибки — сборка начнётся, когда их не останется:",
    stale: "План изменился — показываю новую версию.",
    free: "Правки до сборки бесплатны",
  },
  build: {
    doing: "Собираю",
    ring: "Сборка системы",
    estimating: "считаю время",
    almost: "почти готово",
    leftSec: (s: number) => `осталось ${s} с`,
    leftMin: (m: number) => `осталось ${m} мин`,
    leftMinSec: (m: number, s: number) => `осталось ${m} мин ${s} с`,
    cancelled: "Сборка остановлена",
    reused: (n: number) => `${n} ${plural(n, "этап взят", "этапа взяты", "этапов взяты")} из прошлой попытки`,
    stages: {
      plan: "Сверяю план",
      texts: "Пишу тексты",
      design: "Подбираю оформление",
      compile: "Собираю экраны и данные",
      custom: "Дописываю недостающее",
      gates: "Проверяю, что всё работает",
    } as Record<string, string>,
  },
  failed: {
    title: "Собрать не получилось",
    more: "Подробнее",
    retry: "Попробовать ещё раз",
    code: "Код",
    stage: "Этап",
    message: "Подробности",
    reasons: {
      PLAN_INVALID: "В плане есть ошибка. Откройте план и поправьте отмеченное — потом соберём заново.",
      MODULE_BUG: "Сбой в одном из наших готовых блоков. Мы уже знаем о нём; попробуйте ещё раз чуть позже.",
      STAGE_BUDGET_EXCEEDED: "Этап сборки вышел за свой бюджет и остановлен, чтобы не тратить лишнего.",
      GATES_FAILED: "Система собрана, но не прошла проверки. Можно попробовать исправить.",
      BUDGET_STOPPED: "Сборка остановлена: закончился лимит на эту сборку.",
      LLM_UNAVAILABLE: "Модели сейчас недоступны. Попробуйте ещё раз через несколько минут.",
      CANCELLED: "Сборку остановили.",
    } as Record<string, string>,
    generic: "Что-то пошло не так во время сборки. Попробуйте ещё раз.",
  },
  ready: {
    title: "Система готова",
    meta: (blocks: number) => `${blocks} ${plural(blocks, "блок", "блока", "блоков")} · проверка пройдена`,
    open: { site: "Открыть сайт", cab: "Кабинет", phone: "Телефон" },
  },
  pick: {
    block: (name: string) => `Блок «${name}»`,
    selected: (name: string) => `Выбран блок «${name}»`,
    hints: { view: "Другой вид", remove: "Убрать", up: "Выше", down: "Ниже" },
    variantOf: (i: number, n: number) => `вид ${i} из ${n}`,
    said: {
      view: (t: string) => `${t}: другой вид`,
      remove: (t: string) => `Убрать блок «${t}»`,
      up: (t: string) => `${t}: выше`,
      down: (t: string) => `${t}: ниже`,
      param: (t: string, what: string) => `${t}: ${what}`,
      undo: (t: string) => `Вернуть блок «${t}»`,
    },
    on: "включить",
    off: "выключить",
    params: "Настройки блока",
    removed: (t: string) => `Блок «${t}» убран`,
    undo: "Вернуть",
    free: "Правки блока бесплатны и видны сразу. Или напишите, что поменять.",
    built: "Система уже собрана: правка изменит план, а в самой системе появится после пересборки.",
    rebuild: "План изменён. Нажмите «Пересобрать» — правка появится в системе после сборки.",
    stale:
      "План успели изменить в другом окне — показываю свежую версию. Повторите правку, если она ещё нужна.",
    invalid: (m: string) => `Так не получится: ${m}`,
    wish: (t: string, text: string) => `${t}: ${text}`,
    done: (t: string) => `Готово: ${t}`,
  },
  tags: { goal: "Цель", out: "Не входит", soon: "в разработке" },
  sampleData: {
    services: [
      { n: "Консультация", p: "900 ₽", d: "20 мин" },
      { n: "Первичный приём", p: "2 500 ₽", d: "45 мин" },
      { n: "Повторный визит", p: "1 800 ₽", d: "30 мин" },
    ],
    people: ["Анна Соколова", "Илья Ветров", "Мария Лис"],
    clients: [
      { t: "09:00", n: "Анна К.", s: "Консультация", st: "ok", l: "Пришла" },
      { t: "10:30", n: "Игорь С.", s: "Первичный приём", st: "ok", l: "Подтвердил" },
      { t: "11:00", n: "Мария Л.", s: "Повторный визит", st: "warn", l: "Не ответила" },
      { t: "12:30", n: "Олег Д.", s: "Консультация", st: "mute", l: "Напомнили" },
      { t: "15:00", n: "Елена В.", s: "Первичный приём", st: "bad", l: "Отменила" },
    ],
    slots: ["10:30", "11:00", "12:30", "15:00", "17:30", "19:00"],
    days: ["Чт, 8 окт", "Пт, 9", "Сб, 10"],
    steps: ["Выберите услугу", "Отметьте удобное время", "Получите напоминание"],
    faq: ["Как записаться?", "Можно ли перенести визит?", "Где вы находитесь?"],
    features: ["Без очередей", "Удобное время", "Напомним заранее"],
    nearest: "Ближайшее окно",
    nearestAt: "Чт, 11:00",
    phoneTime: "9:41",
    reminder: (name: string) => `${name}: завтра в 11:00. Придёте?`,
    yes: "Приду",
    move: "Перенести",
    mail: "Напоминание о визите: завтра, 11:00",
    client: "Анна Кузнецова",
    phone: "+7 9•• •••-12-40",
    last: "Прошлый визит",
    lastAt: "12 марта",
    today: "Сегодня",
    todayAt: "09:00 · Консультация",
    note: "Заметка",
    offer: "Предложить перенос",
    leads: [
      { n: "Ирина П.", s: "Новая" },
      { n: "Сергей М.", s: "В работе" },
      { n: "Ольга Т.", s: "Готово" },
    ],
    stages: ["Новая", "В работе", "Готово"],
    date: "Чт, 8 октября",
    domain: (slug: string) => `${slug}.example`,
  },
  blocks: {
    services: "Услуги и цены",
    booking: "Запись",
    bookAt: (t: string) => `Записаться на ${t}`,
    leadForm: "Оставить заявку",
    send: "Отправить",
    name: "Имя",
    phone: "Телефон",
    goals: "Панель цели",
    schedule: "Записи на сегодня",
    rows: (n: number) => `${n} ${plural(n, "запись", "записи", "записей")}`,
    time: "Время",
    who: "Клиент",
    what: "Услуга",
    status: "Напоминание",
    clients: "Клиенты и история",
    leads: "Заявки",
    deals: "Сделки",
    staff: "Сотрудники",
    notifications: "Напоминания",
    mobile: "Сайт на телефоне",
    visitor: "Кабинет посетителя",
    steps: "Как это работает",
    cta: "Записаться",
    goalOf: "цель",
  },
} as const;
