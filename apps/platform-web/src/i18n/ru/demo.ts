// Demo replay of a staff org (B2-02, D76 (12)): the banner, recorded scenarios on S1 and the /admin switch.

export const demo = {
  banner: "Режим показа: ответы моделей записаны, расходов нет",
  scenarios: "Записанные сценарии",
  adminTitle: "Режим показа",
  adminLead:
    "Все прогоны служебной организации идут на записанных ответах моделей: бесплатно, только записанные сценарии. Клиентским организациям режим недоступен.",
  adminToggle: (org: string) => `Режим показа для «${org}»`,
  adminOn: "Режим показа включён",
  adminOff: "Режим показа выключен",
} as const;
