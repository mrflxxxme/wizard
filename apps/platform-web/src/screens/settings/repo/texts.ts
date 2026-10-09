// Russian texts of «Репозиторий» (V3-31) — the system's sync with GitHub and GitLab through pull requests.
import type { RepoCheckState, RepoSyncImport, RepoSyncPr } from "./client.js";

export const repoRu = {
  title: "Репозиторий",
  lead: "Полный исходник системы — в вашем GitHub или GitLab. Каждая правка приходит туда PR с результатами проверок, а изменения ваших разработчиков после мержа возвращаются в Wizard.",
  how: "Wizard остаётся источником истины и публикует систему сам: при подключённом репозитории ревизия публикуется после мержа её PR.",
  ownerOnly: "Подключать репозиторий и менять настройки может владелец организации",
  unavailable: "Синхронизация с репозиториями пока недоступна на платформе",
  connectGithub: "Подключить GitHub",
  connectGitlab: "Подключить GitLab",
  githubOff: "GitHub пока не настроен на платформе",
  gitlabCom: "gitlab.com",
  gitlabOwn: "Свой GitLab",
  gitlabUrl: "Адрес вашего GitLab",
  gitlabUrlHint: "Например, https://gitlab.company.ru — без пути. Сервер должен быть доступен из интернета.",
  gitlabAppId: "Application ID",
  gitlabAppSecret: "Secret",
  gitlabAppHint: (redirect: string) =>
    `Создайте на своём сервере приложение OAuth: Redirect URI ${redirect}, scope api, Confidential. Secret хранится зашифрованным.`,
  gitlabGo: "Перейти в GitLab",
  cancel: "Отмена",
  pickTitle: "Выберите репозиторий",
  pickHint:
    "Лучше пустой: Wizard положит туда исходник системы. В непустой придёт PR, который добавит его рядом с вашими файлами.",
  pick: "Подключить этот репозиторий",
  loadRepos: "Загружаю репозитории…",
  noRepos: "Нет доступных репозиториев. Дайте приложению Wizard доступ к репозиторию и обновите страницу.",
  privateRepo: "приватный",
  provider: { github: "GitHub", gitlab: "GitLab" } as const,
  branch: (b: string) => `основная ветка ${b}`,
  lastSync: (d: string) => `Последняя синхронизация: ${d}`,
  autoMerge: "Автомерж при зелёных проверках",
  autoMergeHint: "Wizard сам сольёт PR, когда G0, G1 и G2 пройдены, а техревью не нашло ошибок.",
  pause: "Приостановить",
  resume: "Возобновить",
  pausedHint: "На паузе ничего не отправляется и не забирается, публикация не ждёт мержа.",
  retry: "Повторить сейчас",
  disconnect: "Отключить",
  disconnectConfirm: (repo: string) =>
    `Отключить ${repo}? Wizard перестанет отправлять PR и забирать изменения. Сам репозиторий не изменится.`,
  disconnected: "Репозиторий отключён",
  saved: "Сохранено",
  queue: (n: number, at: string | null) =>
    `Ждут повтора: ${n}${at ? ` · следующая попытка ${at}` : ""}. Работа в Wizard не останавливается.`,
  stopped: (n: number) => `Остановлено после повторов: ${n}. Нажмите «Повторить сейчас».`,
  publishAfterMerge: (rev: number | null) =>
    rev
      ? `Публикация — после мержа: в основной ветке сейчас ревизия ${rev}.`
      : "Публикация — после мержа первого PR Wizard.",
  prs: "PR Wizard",
  imports: "Изменения из репозитория",
  noPrs: "PR ещё не было.",
  noImports: "Изменений из репозитория ещё не было.",
  rev: (n: number) => `Ревизия ${n}`,
  prState: {
    open: "открыт",
    merged: "слит",
    closed: "закрыт",
    superseded: "заменён новым",
    direct: "сразу в основную ветку",
  } satisfies Record<RepoSyncPr["state"], string>,
  importState: {
    pending: "проверяется",
    noop: "без изменений для Wizard",
    imported: "принят",
    rejected: "не принят",
  } satisfies Record<RepoSyncImport["status"], string>,
  importRev: (n: number) => `ревизия ${n}`,
  check: {
    G0: "G0",
    G1: "G1",
    G2: "G2",
    techreview: "Техревью",
  } as const,
  checkState: {
    pending: "идёт",
    success: "пройдена",
    failure: "не пройдена",
    neutral: "не запускалась",
  } satisfies Record<RepoCheckState, string>,
  selectedNotice: "Репозиторий подключён: первая отправка уже в очереди",
  loadError: "Не удалось загрузить состояние репозитория",
} as const;
