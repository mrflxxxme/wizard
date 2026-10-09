// Russian texts of the repository sync (V3-31): statuses in Wizard, PR titles and descriptions, gate checks, reasons of
// refused imports and of queue errors. The client's developers read the PR texts; the owner reads the rest.
import type { CheckState } from "./providers/types.js";

export const PROVIDER_RU = { github: "GitHub", gitlab: "GitLab" } as const;

export const GATE_NAMES = {
  G0: "Wizard / G0 — сборка и типы",
  G1: "Wizard / G1 — сценарии в браузере",
  G2: "Wizard / G2 — права, ПДн и секреты",
  techreview: "Wizard / Техревью",
  import: "Wizard / Импорт в Wizard",
  /** V3-32: the preview of a developer's PR before its merge. */
  preview: "Wizard / Превью PR",
} as const;

export const GATE_STATE_RU: Record<CheckState, string> = {
  pending: "идёт",
  success: "пройдена",
  failure: "не пройдена",
  neutral: "не запускалась",
};

export const syncRu = {
  prTitle: (revision: number, subject: string) => `Wizard: ревизия ${revision} — ${subject}`.slice(0, 250),
  firstPrTitle: (revision: number) => `Wizard: исходник системы (ревизия ${revision})`,
  prBody: (a: {
    systemName: string;
    revision: number;
    items: string[];
    gates: { name: string; state: CheckState; title: string }[];
    previewUrl: string;
    autoMerge: boolean;
    revertsNote: string | null;
  }) =>
    [
      `Изменения системы «${a.systemName}» из Wizard, ревизия ${a.revision}.`,
      "",
      ...(a.items.length ? [...a.items.slice(0, 30).map((i) => `- ${i}`), ""] : []),
      "**Проверки Wizard**",
      "",
      "| Проверка | Статус | Подробности |",
      "|---|---|---|",
      ...a.gates.map(
        (g) =>
          `| ${g.name.replace(/^Wizard \/ /, "")} | ${GATE_STATE_RU[g.state]} | ${g.title.replace(/\|/g, "/")} |`,
      ),
      "",
      `Превью этой ревизии: ${a.previewUrl}`,
      "",
      "После мержа Wizard заберёт основную ветку, ещё раз прогонит проверки и откроет публикацию. Публикация — в Wizard.",
      a.autoMerge
        ? "Автомерж включён: Wizard сольёт этот PR сам, когда все проверки пройдены."
        : "Автомерж выключен: слейте PR, когда проверки пройдены.",
      ...(a.revertsNote ? ["", a.revertsNote] : []),
      "",
      `<!-- wizard:revision=${a.revision} -->`,
    ].join("\n"),
  supersededComment: (url: string | null, revision: number) =>
    `Этот PR заменён более новой ревизией ${revision} из Wizard${url ? `: ${url}` : ""}. Ветка будет удалена.`,
  rejectedNote: (oid: string, reason: string) =>
    `Изменения коммита ${oid.slice(0, 7)} в основной ветке Wizard не принял (${reason.replace(/\.$/, "")}). Этот PR возвращает основную ветку к состоянию системы в Wizard.`,
  mergeTitle: (revision: number) => `Wizard: слияние ревизии ${revision}`,

  gate: {
    pendingRun: "Проверка идёт",
    notRun: "Для этой ревизии проверка не запускалась — Wizard прогонит её при публикации",
    passed: (n: number) => `Пройдена: ${n} ${n === 1 ? "проверка" : "проверок"} без ошибок`,
    failed: (first: string, more: number) => `${first}${more > 0 ? ` и ещё ${more}` : ""}`,
    techPassed: "Техревью не нашло ошибок",
    techBlocked: (first: string) => `Техревью нашло ошибку: ${first}`,
    techNone: "Техревью этой ревизии не проводилось",
  },

  status: {
    pending: "Ждём выбора репозитория",
    active: "Синхронизация работает",
    paused: "Синхронизация на паузе",
    error: "Синхронизация остановлена из-за ошибки",
  },

  errors: {
    UNAVAILABLE: (p: string) =>
      `${p} сейчас недоступен. Повторим автоматически — работа в Wizard не останавливается`,
    RATE_LIMITED: (p: string) => `${p} попросил подождать (лимит запросов). Повторим автоматически`,
    AUTH_FAILED: (p: string) =>
      p === "GitHub"
        ? "GitHub не принял доступ Wizard: проверьте, что приложение Wizard установлено и у него есть доступ к репозиторию"
        : "GitLab не принял доступ Wizard: подключите репозиторий заново",
    FORBIDDEN: (p: string) => `${p} запретил действие: у приложения Wizard не хватает прав на репозиторий`,
    NOT_FOUND: (p: string) => `${p} не нашёл репозиторий или ветку: возможно, его переименовали или удалили`,
    CONFLICT: (p: string) => `${p} не смог выполнить действие из-за конфликта — подробности в PR`,
    INVALID: (p: string) => `${p} отклонил запрос Wizard`,
    PROTOCOL: (p: string) => `${p} ответил непонятно. Повторим автоматически`,
    PUSH_REJECTED: (p: string) => `${p} не принял изменения Wizard (push отклонён)`,
    KMS_UNAVAILABLE: "Хранилище ключей недоступно. Повторим автоматически",
    INTERNAL: "Внутренняя ошибка синхронизации. Повторим автоматически",
  },

  import: {
    noBase:
      "Основная ветка ещё не синхронизирована с Wizard: сначала слейте PR Wizard с исходником системы, потом присылайте свои изменения",
    conflict: (files: string[], revision: number, lines: { path: string; from: number; to: number }[] = []) =>
      `Конфликт: ${files.length === 1 ? "файл" : "файлы"} ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` и ещё ${files.length - 5}` : ""} ${files.length === 1 ? "изменён" : "изменены"} и в репозитории, и в Wizard (ревизия ${revision})${
        lines.length
          ? ` в одних и тех же строках: ${lines
              .slice(0, 5)
              .map((l) => `${l.path}:${l.from > l.to ? l.to : l.from}${l.to > l.from ? `–${l.to}` : ""}`)
              .join(", ")}`
          : ""
      }. Перенесите свою правку поверх ветки последнего PR Wizard или повторите её в Wizard`,
    mergedLines: (files: string[]) =>
      `Правки в ${files.length === 1 ? "файле" : "файлах"} ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` и ещё ${files.length - 5}` : ""} объединены построчно с правками Wizard`,
    incompatible: (reasons: string[]) =>
      `Изменения нельзя перенести в Wizard: ${reasons.slice(0, 5).join("; ")}${reasons.length > 5 ? ` и ещё ${reasons.length - 5}` : ""}`,
    badSpec: (msgs: string[]) => `spec/appspec.json не прошла проверку: ${msgs.slice(0, 3).join("; ")}`,
    gatesFailed: (level: string, msgs: string[]) =>
      `Проверка ${level} не пройдена: ${msgs.slice(0, 3).join("; ") || "подробности в отчёте"}`,
    building: "Идёт сборка в Wizard — импорт подождёт её окончания",
    noGates: "Проверки (гейты) не подключены к платформе — импорт подождёт",
    fetchIncomplete: "Git-сервер прислал не все объекты основной ветки. Повторим автоматически",
    summary: (provider: string, subject: string, pr: number | null) =>
      `Импорт из ${provider}: ${subject}${pr ? ` (PR #${pr})` : ""}`.slice(0, 2000),
    generatedIgnored:
      "Бриф, тесты и AGENTS.md Wizard пишет сам — правки этих файлов не перенесены, следующий PR Wizard вернёт их",
    imported: (revision: number) => `Изменения приняты: ревизия ${revision}`,
    path: (p: string) => `путь ${p} вне ui/, functions/, assets/ и spec/appspec.json`,
    symlink: (p: string) => `${p} — символьная ссылка или подмодуль, Wizard их не поддерживает`,
    tooLarge: (p: string, mb: number) => `${p} больше ${mb} МБ`,
    notText: (p: string) => `${p} — не текст в UTF-8`,
    tooMany: (n: number) => `слишком много файлов (${n}, можно не больше 2000)`,
    badSpecJson: "spec/appspec.json — не JSON",
  },

  /** V3-32: previews of the client's developers' PRs before the merge. */
  preview: {
    status: {
      pending: "Проверяем",
      passed: "Проверки пройдены",
      failed: "Проверка не пройдена",
      rejected: "Изменения нельзя перенести в Wizard",
      noop: "PR не меняет файлов системы",
      closed: "PR закрыт",
    } as Record<string, string>,
    noBase:
      "Ветка PR не основана на основной ветке, синхронизированной с Wizard: обновите её от основной ветки и запушьте снова",
    noop: "PR не меняет ui/, functions/, assets/ и spec/appspec.json — после мержа переносить в Wizard нечего",
    building: "Идёт сборка в Wizard — превью PR подождёт её окончания",
    passed: "G0, G1 и G2 пройдены на системе с изменениями PR — после мержа Wizard примет их",
    failed: (level: string, title: string) => `${level} не пройдена: ${title}`.slice(0, 250),
    notRun: (level: string) => `Не запускалась: раньше не прошла ${level}`,
    summary: (a: {
      files: { path: string; status: string }[];
      merged: string[];
      gates: { level: string; passed: boolean | null; title: string }[];
      url: string;
    }) =>
      [
        "Wizard проверил систему с изменениями этого PR, как если бы его слили сейчас поверх текущей ревизии.",
        "",
        ...(a.files.length
          ? [
              "**Файлы PR, которые переносятся в Wizard**",
              "",
              ...a.files.slice(0, 30).map((f) => `- ${f.path} (${f.status})`),
              "",
            ]
          : []),
        ...(a.merged.length
          ? [`Объединены построчно с правками Wizard: ${a.merged.slice(0, 10).join(", ")}.`, ""]
          : []),
        "| Проверка | Статус |",
        "|---|---|",
        ...a.gates.map(
          (g) =>
            `| ${g.level} | ${g.passed === null ? "не запускалась" : g.passed ? "пройдена" : `не пройдена: ${g.title.replace(/\|/g, "/")}`} |`,
        ),
        "",
        `Превью PR в Wizard: ${a.url}`,
      ].join("\n"),
  },

  publishBlocked: (pr: { number: number | null; url: string | null } | null, repo: string) =>
    pr?.number
      ? `Сначала слейте PR #${pr.number} в основную ветку репозитория ${repo}: после мержа Wizard проверит изменения и откроет публикацию. Или включите автомерж в настройках «Репозиторий»`
      : `Изменения ещё отправляются в репозиторий ${repo}: публикация откроется после мержа PR. Синхронизацию можно приостановить в настройках «Репозиторий»`,

  connect: {
    notConfiguredGithub: "Подключение GitHub пока не настроено на платформе",
    notConfiguredGitlab: "Подключение gitlab.com пока не настроено на платформе: укажите адрес своего GitLab",
    stateInvalid: "Ссылка подключения устарела или не ваша — начните подключение заново",
    installationNotYours: "Эта установка приложения Wizard не принадлежит вашей учётной записи GitHub",
    noAccess: "У приложения Wizard нет доступа к этому репозиторию",
    alreadyLinked: "Этот репозиторий уже подключён к другой системе",
    alreadyChosen: "Репозиторий уже выбран. Чтобы сменить его, отключите текущий и подключите заново",
    alreadyLinkedOther: "К системе уже подключён другой репозиторий — сначала отключите его",
    hostInvalid: "Адрес GitLab указан с ошибкой: нужен адрес вида https://gitlab.example.ru без пути",
    hostPrivate: "Адрес GitLab должен быть доступен из интернета",
    needOwnApp:
      "Для своего GitLab укажите Application ID и Secret приложения OAuth, созданного на вашем сервере",
    notPending: "Сначала подключите аккаунт GitHub или GitLab",
    unavailable: "Синхронизация с репозиториями выключена на платформе",
    cloneHost: "Адрес репозитория ведёт на другой сервер — подключение отклонено",
  },
} as const;
