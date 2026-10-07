// /admin «Кандидаты в модули» (B2-26 module factory) and the client's consent to «Теперь умеем» letters (S-billing).

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export const factory = {
  tab: "Кандидаты в модули",
  lead:
    "Раз в неделю просьбы клиентов и удачные дописывания собираются в рейтинг: что просят чаще, то выше. " +
    "Одобрите кандидата в работу или выключите лишнее. Когда модуль появится в каталоге, отметьте «Модуль готов» — " +
    "клиенты, которые просили и согласились на письма, получат письмо «Теперь умеем».",
  computed: (at: string) => `Рейтинг пересчитан ${at}`,
  never: "Рейтинг ещё не считали",
  recompute: "Пересчитать сейчас",
  recomputed: (n: number, sent: number) =>
    `Пересчитано: ${n} ${plural(n, "кандидат", "кандидата", "кандидатов")}` +
    (sent > 0 ? `, писем ушло: ${sent}` : ""),
  filter: "Показать",
  filters: {
    open: "Новые и в работе",
    new: "Новые",
    approved: "В работе",
    disabled: "Выключенные",
    ready: "Готовые",
    all: "Все",
  } as Record<string, string>,
  empty: "Кандидатов пока нет: рейтинг появится, когда клиенты попросят то, чего платформа ещё не умеет.",
  colRank: "Место",
  colTitle: "Что просят",
  colCategory: "Тема",
  colWeek: "За неделю",
  colTotal: "Всего",
  colSystems: "Систем",
  colClients: "Клиентов",
  colStatus: "Статус",
  status: {
    new: "новый",
    approved: "в работе",
    disabled: "выключен",
    ready: "модуль готов",
  } as Record<string, string>,
  week: (requests: number, custom: number) =>
    custom > 0 ? `${requests + custom} (дописано: ${custom})` : String(requests),
  back: "Ко всем кандидатам",
  counts: (week: number, total: number, systems: number, clients: number) =>
    `За неделю: ${week}. Всего: ${total}. Систем: ${systems}. Клиентов: ${clients}.`,
  examplesTitle: "Как просили",
  sourceCustom: "дописано под клиента",
  sourceRequest: "просьба клиента",
  suggested: (name: string, ready: boolean) => `Похоже на модуль «${name}»${ready ? "" : " (скоро)"}`,
  module: "Модуль каталога",
  moduleNone: "Не выбран",
  moduleReady: "готов",
  moduleSoon: "скоро",
  moduleLinked: (name: string) => `Связан с модулем «${name}»`,
  note: "Заметка",
  approve: "Одобрить в работу",
  disable: "Выключить",
  ready: "Модуль готов",
  readyConfirm:
    "Запросы клиентов отметятся как сделанные, а тем, кто согласился на письма, уйдёт письмо «Теперь умеем» со ссылкой на их систему. Нажмите «Модуль готов» ещё раз, чтобы подтвердить.",
  readyNeedsModule: "Выберите модуль каталога, который закрывает этот запрос.",
  readyFinal: "Решение окончательное: модуль выпущен, письма отправлены.",
  announced: (done: number, sent: number, noConsent: number) =>
    `Готово. Запросов закрыто: ${done}. Писем отправлено: ${sent}.` +
    (noConsent > 0 ? ` Без согласия на письма: ${noConsent} — им не пишем.` : ""),
  saved: "Сохранено",
  requestsTitle: "Запросы клиентов",
  requestDone: "сделано",
  requestOpen: "ждёт",
  noSystem: "система удалена",
  notified: (n: number) => `Письмо «Теперь умеем» получили: ${n}`,
  consent: {
    title: "Письма о новых возможностях",
    label: "Сообщать письмом, когда Born to Build научится тому, что я просил",
    hint: "Только про ваши просьбы, которые платформа пока не умела. Рекламы нет, отключить можно здесь же.",
    saved: "Сохранено",
  },
};
