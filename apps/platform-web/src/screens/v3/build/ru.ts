// Russian texts of the live v3 build on the canvas (V3-17; product.yaml D48: plain words, D77_v3 (10)).

const plural = (n: number, one: string, few: string, many: string): string => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/** «42 ₽», «1 200 ₽» — the same rounding as the harness line (stages.ts rubLabel). */
export const rub = (x: number): string => `${Math.round(x).toLocaleString("ru-RU")} ₽`;
/** Whole minutes, at least one. */
const min = (sec: number) => Math.max(1, Math.round(sec / 60));

export const liveRu = {
  kicker: "Сборка по брифу",
  title: { running: "Собираю систему", done: "Система собрана", failed: "Сборка остановилась" },
  now: (label: string) => `Сейчас: ${label}`,
  starting: "Готовлюсь к сборке",
  time: {
    left: (sec: number) =>
      sec < 60
        ? "Осталось меньше минуты"
        : `Осталось около ${min(sec)} ${plural(min(sec), "минуты", "минут", "минут")}`,
    almost: "Почти готово — заканчиваю проверку",
    going: (sec: number, capSec: number) =>
      `${sec < 60 ? "Идёт меньше минуты" : `Идёт ${Math.floor(sec / 60)} мин`} · не дольше ${min(capSec)} мин`,
    took: (sec: number) => (sec < 60 ? "Собрано меньше чем за минуту" : `Собрано за ${min(sec)} мин`),
    stopped: (sec: number) => (sec < 60 ? "Шла меньше минуты" : `Шла ${min(sec)} мин`),
  },
  spend: {
    /** The harness line: «потрачено 120 ₽ из 500 ₽». */
    line: (spent: number, cap: number) => `потрачено ${rub(spent)} из ${rub(cap)}`,
    title: (spent: number, cap: number) => `Потрачено ${rub(spent)} из ${rub(cap)}`,
    cap: (cap: number) => `Потолок сборки — ${rub(cap)}: дороже не будет.`,
    reused: (x: number) => `Из них ${rub(x)} — шаги прошлой сборки, второй раз они не оплачиваются.`,
  },
  scenarios: {
    title: "Сценарии брифа",
    count: (done: number, total: number) => `готово ${done} из ${total}`,
    none: "В брифе нет сценариев — собираю каркас страниц.",
    must: "обязательно",
    should: "желательно",
    status: {
      pending: "в очереди",
      running: "делаю сейчас",
      passed: "готово",
      reused: "готово в прошлой сборке",
      failed: "в «Запросы на развитие»",
      stopped: "в «Запросы на развитие»",
      halted: "остановлен",
    },
    reason: (r: string) => `Причина: ${r}. Его можно доделать правкой.`,
  },
  leave:
    "Можно закрыть страницу: сборка продолжится, а ход сохранится. Когда система будет готова, пришлём письмо.",
  notify: {
    ask: "Сообщить в браузере, когда будет готово",
    on: "Сообщу в браузере, когда система будет готова.",
    denied: "Уведомления в браузере выключены — о готовности придёт письмо.",
  },
  more: {
    summary: "Подробнее",
    stages: "Этапы",
    gates: "Проверки",
    checkpoints: "Чекпоинты",
    stage: {
      pending: "впереди",
      running: "идёт",
      done: "готово",
      reused: "из прошлой сборки",
      skipped: "пропущен",
    } as Record<string, string>,
    gate: (level: string, revision: number | null, passed: boolean, failed: number) =>
      `${level}${revision !== null ? `, ревизия ${revision}` : ""}: ${
        passed
          ? "пройдена"
          : `не пройдена (${failed} ${plural(failed, "замечание", "замечания", "замечаний")})`
      }`,
    noGates: "Проверок ещё не было.",
    saved: (n: number) => `Сохранено шагов: ${n}.`,
    reused: (n: number) => `Взято из прошлой сборки: ${n} — повторно не оплачиваются.`,
    preview: (r: number | null) => (r === null ? "Превью ещё нет." : `Превью — ревизия ${r}.`),
  },
  preview: {
    label: "Ваша система",
    frame: "Превью собираемой системы",
    frameSettled: "Превью системы",
    unavailable: "Превью сейчас не открылось — обновите страницу через минуту.",
    revision: (r: number) => `ревизия ${r}`,
    open: "Открыть в новой вкладке",
    pending: "Каркас страниц появится здесь через пару минут — сразу после подбора стиля.",
    loading: "Загружаю превью…",
    growing: "Превью обновляется, когда готов очередной сценарий.",
  },
  stop: {
    button: "Остановить сборку",
    confirm:
      "Остановить сборку? Потраченное не вернётся, но готовые шаги сохранятся — следующая сборка начнёт с них и не заплатит за них снова.",
    yes: "Да, остановить",
    no: "Продолжить сборку",
    stopping: "Останавливаю…",
    failed: "Не удалось остановить сборку — попробуйте ещё раз.",
  },
  ready: {
    title: "Система готова",
    meta: (done: number, total: number) =>
      total === 0
        ? "Каркас страниц готов"
        : `Готово ${done} из ${total} ${plural(total, "сценария", "сценариев", "сценариев")} брифа`,
    look: "Посмотреть систему",
  },
  toast: {
    title: (name: string) => (name ? `Система «${name}» готова` : "Система готова"),
    close: "Закрыть уведомление",
  },
  announce: {
    stage: (label: string) => `Сборка: ${label}`,
    passed: (title: string) => `Готово: ${title}`,
    moved: (title: string) => `Отложено в «Запросы на развитие»: ${title}`,
    preview: "Превью обновилось",
    done: "Система собрана",
    failed: "Сборка остановилась",
  },
} as const;
