// Russian texts of the agent for compatible repositories (V3-32): statuses, reasons of failed tasks, PR titles and
// descriptions. The client's developers read the PRs; the owner reads the rest.
import type { CompatReport, RepoAgentResult, RepoRules } from "@wizard/agents/repo";
import { scrub } from "@wizard/pii";
import type { AgentRepoStatus, TaskKind, TaskStatus } from "./store.js";

export const AGENT_CHECK_NAME = "Wizard / Агент — песочница и техревью";

const secs = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} мин` : `${Math.max(1, Math.round(ms / 1000))} с`;
const clean = (s: string) => scrub(s).text;

export const agentRu = {
  repoStatus: {
    pending: "Ждём выбора репозитория",
    checking: "Проверяем совместимость",
    ready: "Агент может работать",
    incompatible: "Репозиторий несовместим",
    unchecked: "Сборка и тесты ещё не проверены",
    error: "Ошибка подключения",
  } satisfies Record<AgentRepoStatus, string>,
  taskKind: {
    check: "Проверка совместимости",
    rules: "Правила для агентов (AGENTS.md)",
    change: "Задача",
  } satisfies Record<TaskKind, string>,
  taskStatus: {
    queued: "В очереди",
    running: "Агент работает",
    done: "Готово",
    failed: "Не получилось",
  } satisfies Record<TaskStatus, string>,

  unavailable: "Агент для репозиториев выключен на платформе",
  notReady: (r: CompatReport | null) =>
    r?.verdict === "incompatible"
      ? `Репозиторий несовместим: ${r.blocking_ru ?? "подробности в отчёте"}`
      : r?.verdict === "unchecked"
        ? `Сборка и тесты репозитория ещё не проверены: ${r.blocking_ru ?? "песочница недоступна"}`
        : "Сначала дождитесь проверки совместимости репозитория",
  taskEmpty: "Опишите задачу словами",
  emptyRepo: "Репозиторий пуст — агенту нечего дорабатывать",
  tooLarge: "Репозиторий больше, чем берёт агент (5000 файлов и 64 МБ)",
  fetchIncomplete: "Git-сервер прислал не все объекты основной ветки. Повторим автоматически",
  noMoreCompatible: (r: CompatReport) =>
    r.verdict === "unchecked"
      ? `Сборка и тесты репозитория не проверены: ${r.blocking_ru ?? r.summary_ru}`
      : `Репозиторий больше не совместим: ${r.blocking_ru ?? r.summary_ru}`,
  rulesExist: "Правила в репозитории уже есть — предлагать AGENTS.md не нужно",
  pushRejected: "Git-сервер не принял ветку агента",
  internal: "Внутренняя ошибка агента. Повторим автоматически",

  rulesTitle: "Wizard: правила для агентов (AGENTS.md)",
  rulesBody: (repo: string) =>
    [
      `В репозитории ${repo} нет AGENTS.md, CLAUDE.md и CONTRIBUTING — правил, по которым работают разработчики и ИИ-агенты.`,
      "",
      "Wizard предлагает черновик AGENTS.md: стек, команды установки, сборки и тестов, структура и правила работы — по составу репозитория, без модели. Поправьте его под себя и слейте: агент Wizard будет следовать этим правилам; пока PR не слит, агент работает по этому черновику.",
      "",
      "Мержит только человек: Wizard этот PR не сливает.",
      "",
      "<!-- wizard:agent-rules -->",
    ].join("\n"),

  changeTitle: (title: string) => `Wizard: ${title}`.slice(0, 250),
  commitMessage: (title: string, summary: string, taskId: string) =>
    `Wizard: ${clean(title)}\n\n${clean(summary)}\n\nWizard-Task: ${taskId}\n`,
  changeBody: (a: {
    task: string;
    result: RepoAgentResult;
    report: CompatReport;
    rules: RepoRules;
    rulesPrUrl: string | null;
    taskId: string;
  }) => {
    const sb = a.report.sandbox?.steps ?? [];
    const install = sb.find((s) => s.step === "install");
    const v = a.result.verify;
    const files = [...a.result.changes].map(
      ([p, t]) => `- ${p} (${t === null ? "удалён" : "изменён или создан"})`,
    );
    const review = a.result.review;
    return [
      "Черновой PR агента Wizard по задаче владельца.",
      "",
      "**Задача**",
      "",
      ...clean(a.task)
        .split("\n")
        .map((l) => `> ${l}`),
      "",
      "**Что сделано**",
      "",
      clean(a.result.summary_ru),
      "",
      "**Файлы**",
      "",
      ...files.slice(0, 50),
      "",
      "**Проверки в песочнице**",
      "",
      "| Проверка | Результат |",
      "|---|---|",
      ...(install
        ? [
            `| Установка зависимостей (${install.command}) | ${install.ok ? "пройдена" : "не пройдена"}, ${secs(install.durationMs)} |`,
          ]
        : []),
      ...(v.build
        ? [`| Сборка | ${v.build.ok ? "пройдена" : "не пройдена"}, ${secs(v.build.durationMs)} |`]
        : []),
      ...(v.test
        ? [`| Тесты репозитория | ${v.test.ok ? "пройдены" : "не пройдены"}, ${secs(v.test.durationMs)} |`]
        : []),
      `| Техревью | ${review?.blockers.length ? `блокеры: ${review.blockers.length}` : "блокеров нет"}${review?.reviewer.status === "skipped" ? ` (ревьюер пропущен: ${review.reviewer.reason ?? "недоступен"})` : ""} |`,
      ...(review?.findings.length
        ? [
            "",
            "Замечания ревьюера:",
            ...review.findings.map((f) => `- ${f.file}: ${f.title_ru} (${f.severity})`),
          ]
        : []),
      "",
      `**Правила репозитория:** ${
        a.rules.sources.length
          ? a.rules.sources.map((s) => s.path).join(", ")
          : `нет — агент работал по черновику AGENTS.md от Wizard${a.rulesPrUrl ? ` (${a.rulesPrUrl})` : ""}`
      }.`,
      "",
      "Код репозитория обрабатывали только модели с инференсом в России. Агент работал в песочнице без сети: сеть была только у установки зависимостей.",
      "",
      "Мержит только человек: Wizard этот PR не сливает, автомерж для него выключен. Деплой — вашими средствами.",
      "",
      `<!-- wizard:agent-task=${a.taskId} -->`,
    ].join("\n");
  },
  checkSummary: (r: RepoAgentResult) =>
    [
      `Сборка: ${r.verify.build ? (r.verify.build.ok ? "пройдена" : "не пройдена") : "нет"}`,
      `Тесты: ${r.verify.test ? (r.verify.test.ok ? "пройдены" : "не пройдены") : "нет"}`,
      `Техревью: ${r.review?.blockers.length ? "есть блокеры" : "блокеров нет"}`,
    ].join("\n"),

  connect: {
    notConfiguredGithub: "Подключение GitHub пока не настроено на платформе",
    stateInvalid: "Ссылка подключения устарела или не ваша — начните подключение заново",
    noAccess: "У приложения Wizard нет доступа к этому репозиторию",
    alreadyChosen: "Репозиторий уже выбран — чтобы сменить его, отключите и подключите заново",
    alreadyConnected: "Этот репозиторий уже подключён к агенту",
    notPending: "Сначала подключите аккаунт GitHub или GitLab",
  },
} as const;
