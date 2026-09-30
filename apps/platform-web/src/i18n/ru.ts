// All user-facing text of platform-web (platform-screens.yaml#stack: Russian only).

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** Credits in UI: rounded to 0.1 (api.yaml#info). */
export const fmtCredits = (n: number): string =>
  (Math.round(n * 10) / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

/** OrgSettings.buildModelLabel of the RF build contour (@wizard/llm RU_BUILD_LABEL): no PII scrub wording then. */
export const RU_BUILD_LABEL = "модели в РФ";
const scrubbed = (label: string): boolean => label !== RU_BUILD_LABEL;

export const ru = {
  plural,
  appName: "Wizard",
  errors: {
    generic: "Что-то пошло не так. Попробуйте ещё раз.",
    network: "Нет связи с сервером. Проверьте подключение и повторите.",
    notFound: "Страница не найдена",
    toStart: "На главную",
    systemNotFound: "Система не найдена или у вас нет к ней доступа.",
    retry: "Повторить",
    topUp: "Пополнить",
  },
  rail: {
    home: "На главную",
    newSystem: "Новая система",
    settings: "Настройки системы появятся позже",
  },
  start: {
    title: "Какую систему соберём?",
    subtitle:
      "Опишите задачу своими словами: кто пользуется системой, что в ней хранится и что должно происходить. Остальное уточню кнопками.",
    promptLabel: "Описание системы",
    promptPlaceholder:
      "Например: регистрация на форум на 600 человек с разными билетами, оплатой и QR на входе…",
    submit: "Начать →",
    submitHint: "Ctrl+Enter — отправить",
    templates: "Шаблоны",
    upload: "Загрузить таблицу",
    uploadHint: "Таблицу можно загрузить после первого сообщения",
    policy: (label: string | undefined) =>
      `${label ? `Сборка: ${label}${scrubbed(label) ? ", ПДн удаляются до отправки" : ""}` : "ПДн удаляются до отправки моделям"} · данные систем: только в РФ`,
    ruOnly: "Только РФ",
    ruOnlyHint: "Переключатель «только российский контур» появится позже",
    credits: "Кредиты",
    creditsHint: "Баланс кредитов появится позже",
    systems: "Ваши системы",
    stageDraft: "черновик",
    stageProd: "prod",
    draftTitle: "Черновик",
    prodTitle: "Опубликовано",
  },
  templates: [
    {
      id: "event_registration",
      label: "Мероприятие и регистрация",
      prompt:
        "Мероприятие: регистрация участников с разными типами билетов и лимитами, онлайн-оплата, QR-билет и проверка на входе, напоминания участникам.",
    },
    {
      id: "made_to_order",
      label: "Заказы и предзаказы",
      prompt:
        "Приём заказов и предзаказов: каталог с опциями и ценой, предоплата онлайн, производство к дате, статусы заказа и уведомления покупателю.",
    },
    {
      id: "requests_moderation",
      label: "Заявки и модерация",
      prompt:
        "Приём заявок: форма заявки, модерация с одобрением или отказом, уведомления заявителю, статусы и отчёт по заявкам.",
    },
    {
      id: "internal_tool",
      label: "Внутренний инструмент",
      prompt:
        "Внутренний инструмент команды: учёт записей с ответственными и статусами, права по ролям, отчёт для руководителя.",
    },
    {
      id: "client_cabinet",
      label: "Кабинет клиента",
      prompt:
        "Кабинет клиента: вход по коду, клиент видит только свои заказы и документы, менеджер ведёт всех клиентов.",
    },
    { id: "custom", label: "Своя задача", prompt: "" },
  ],
  workspace: {
    newSystem: "Новая система",
    stage: {
      interview: "понимание задачи",
      card: "карточка системы",
      building: "сборка",
      ready: "готово к проверке",
      failed: "сборка не удалась",
    } as Record<string, string>,
    tabChat: "Чат",
    tabPreview: "Превью",
    loading: "Загружаю систему…",
    inputPlaceholder: "Напишите сообщение…",
    inputPlaceholderCard: "Поправить словами…",
    send: "Отправить",
    lockedHint: "Правки можно отправить после сборки",
    styleToggle: "Стиль",
  },
  chat: {
    you: "Вы",
    agents: { orchestrator: "Оркестратор", builder: "Строитель", qa: "Проверка" } as Record<string, string>,
    system: "Wizard",
    piiCategory: {
      phone: "телефон",
      email: "email",
      fio: "ФИО",
      address: "адрес",
      birthdate: "дата рождения",
      other: "другие персональные данные",
    } as Record<string, string>,
    piiNotice: (categories: string) =>
      `В описании есть персональные данные (${categories}). Для сборки они не нужны: мы обработаем ваш текст в российском контуре, а во внешние модели передадим его без этих данных. Реальные данные клиентов лучше вносить уже в готовую систему.`,
    piiRuOnly: "Сборка идёт на моделях в РФ.",
    analyzing: "Разбираю задачу…",
    cardMessage: (v: number) => `Карточка системы · версия ${v}`,
    answered: "Ответ принят",
  },
  questions: {
    progress: (k: number, n: number) => `Вопрос ${k} из ${n}`,
    recommended: "рекомендую",
    custom: "Свой вариант",
    customPlaceholder: "Опишите свой вариант (до 500 символов)",
    next: "Далее",
    finish: "Готово",
    acceptRest: "Остальное — по рекомендациям",
  },
  understanding: {
    title: "Как я понял задачу",
    roles: "Роли",
    core: "Ядро",
    specifics: "Специфика",
    constraints: "Ограничения",
    forks: "Развилки",
    forkFallback: "Уточнение",
    forkStatus: { resolved: "решено", asking: "выбираете сейчас", pending: "ожидает" } as Record<
      string,
      string
    >,
    skeleton: {
      catalog: "каталог",
      application: "заявка",
      process: "процесс",
      payment: "оплата",
      fulfillment: "выдача",
    } as Record<string, string>,
  },
  card: {
    version: (v: number) => `Карточка системы · версия ${v}`,
    counts: (r: number, d: number, s: number, i: number) =>
      `${r} ${plural(r, "роль", "роли", "ролей")} · ${d} ${plural(d, "вид", "вида", "видов")} данных · ${s} ${plural(s, "экран", "экрана", "экранов")} · ${i} ${plural(i, "интеграция", "интеграции", "интеграций")}`,
    spec: "Спека · гарантии",
    code: "Код · гибкость",
    integrations: "Интеграции",
    keyNeeded: "ключ",
    acceptance: "Критерии приёмки → проверки",
    roles: "Роли",
    data: "Данные",
    pii: "Персональные данные",
    estimate: (expected: number, min?: number, max?: number) =>
      `≈ ${fmtCredits(expected)} ${plural(Math.round(expected), "кредит", "кредита", "кредитов")}${min !== undefined && max !== undefined ? ` · ${min}–${max} минут` : ""}`,
    cap: (cap: number, label: string | undefined) =>
      `Потолок — ${fmtCredits(cap)} ${plural(cap, "кредит", "кредита", "кредитов")}.${label ? ` Сборка: ${label}${scrubbed(label) ? " без ПДн" : ""}` : " Сборка без ПДн"} · данные: модели в РФ`,
    edit: "Изменить",
    build: "Строить",
    updated: "Карточка обновлена",
    answersSummary: (n: number) => `Ответы ${n} из ${n}:`,
    acceptanceNote:
      "Критерии приёмки станут автоматическими проверками: сборка не закончится, пока они не пройдут.",
    changeTitle: "Что меняется",
    stale: "Карточка изменилась — показываю новую версию.",
  },
  build: {
    progress: "Ход сборки",
    credits: (used: number, cap: number | null) =>
      cap === null ? `${fmtCredits(used)} кредитов` : `${fmtCredits(used)} из ≤${fmtCredits(cap)} кредитов`,
    queued: "в очереди",
    running: "выполняется",
    done: "готово",
    attempt: (n: number) => `попытка ${n}`,
    modelNotice: "Часть шагов выполнена на моделях в РФ",
    cancel: "Остановить",
    gate: { G0: "Проверки уровня 0", G1: "Проверки уровня 1", G2: "Проверки уровня 2" } as Record<
      string,
      string
    >,
    gateStatus: {
      pending: "ожидает",
      running: "проверяется",
      passed: "пройдено",
      failed: "не пройдено",
    } as Record<string, string>,
    afterG1: "после G1",
    gateCount: (passed: number, total: number) => `${passed} из ${total}`,
    budgetExceeded: (cap: number) =>
      `Достигнут потолок ${fmtCredits(cap)} ${plural(Math.round(cap), "кредит", "кредита", "кредитов")}`,
    decisionSend: "Ответить",
    freeTextPlaceholder: "Опишите по-другому (до 2000 символов)",
    recommended: "рекомендую",
    lock: (holder: string | undefined, position: number | undefined) =>
      `Сейчас меняет ${holder ?? "другой участник"}. Вы в очереди: ${position ?? 1}`,
    fix: "Исправить",
    retry: "Повторить",
    secretTitle: (name: string) =>
      `Нужны ключи ${name}. Вводятся в защищённую форму, агенты видят только ссылку на секрет`,
    secretEnter: "Ввести",
    secretTest: "Тестовый режим",
    secretLabel: "Ключ",
    stopped: "Сборка остановлена",
  },
  gates: {
    report: "Отчёт проверок",
    nonBlocking: "Не блокирует",
    summary: (pass: number, total: number) => `${pass} из ${total} пройдено`,
    passed: "пройдено",
    failed: "не пройдено",
    showChecks: "Подробнее",
    hideChecks: "Скрыть",
    noReport: "Отчёта проверок пока нет",
  },
  publish: {
    title: "Публикация",
    address: (slug: string) => `Адрес: ${slug}.<домен систем>`,
    features: "Отдельный домен систем · хостинг в РФ · PITR · откат к любой ревизии",
    cardStatus: "Привязка карты РФ понадобится для публикации",
    submit: "Опубликовать",
    unavailable: "Публикация появится в следующей версии",
    blockers: {
      GATES_FAILED: (levels: string) => (levels ? `Не пройдены проверки: ${levels}` : "Не пройдены проверки"),
      NOT_OWNER: "Публикует владелец",
      CARD_BINDING_REQUIRED: "Привяжите карту РФ",
      OPERATOR_NAME_REQUIRED: "Укажите оператора ПДн",
      OPERATOR_CONTACT_REQUIRED: "Укажите оператора ПДн",
      OPERATOR_ADDRESS_REQUIRED: "Укажите оператора ПДн",
      PHONE_LOGIN_PLAN_REQUIRED: "Вход по телефону доступен на тарифах Старт и Бизнес",
      PLAN_LIMIT: "Лимит опубликованных систем тарифа",
      FOUNDER_REVIEW_PENDING: "Ждёт проверки",
      SYSTEM_SUSPENDED: "Система снята по жалобе",
    } as Record<string, string | ((levels: string) => string)>,
    edits: "Правки",
  },
  preview: {
    draft: "DRAFT",
    draftTitle: "Черновик",
    testData: "DRAFT · тестовые данные",
    tabPreview: "Превью",
    tabCode: "Код",
    tabData: "Данные",
    tabLater: "Появится позже",
    roles: "Смотреть как",
    width: "Ширина превью",
    widthLabel: (px: number) => `${px} px`,
    pending: "Превью появится после первой проверки",
    failed: "Превью не загрузилось",
    reload: "Обновить",
    frameTitle: "Превью системы",
  },
  style: {
    title: "Стиль",
    subtitle: "меняется мгновенно, без кредитов",
    accent: "Акцент",
    accentCustom: "Свой цвет (#RRGGBB)",
    font: "Шрифт",
    radius: "Скругления",
    density: "Плотность",
    densityLabel: { compact: "компактно", regular: "обычно" } as Record<string, string>,
    logo: "Логотип",
    logoHint: "PNG или WebP до 1 МБ",
    logoTooBig: "Файл больше 1 МБ",
    logoType: "Нужен PNG или WebP",
    mode: "Тема",
    modeLabel: { light: "светлая", dark: "тёмная", auto: "авто" } as Record<string, string>,
    hint: "Сложнее, чем токены? Кликните по элементу в превью или напишите в чат",
    saving: "Сохраняется…",
    saved: "Сохранено",
    afterBuild: "Сохраним после сборки",
    close: "Закрыть",
  },
} as const;
