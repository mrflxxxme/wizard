// Closed vocabulary of business goals (specs/modules/modules.yaml#goals). A plan names 1–3 of them; every module
// manifest says which ones it closes. Adding a goal is a spec change (modules.yaml first, then this list).
import { z } from "zod";

export const GOALS = [
  { id: "attract", label: "Привлечь посетителя и объяснить предложение" },
  { id: "leads", label: "Получать заявки и не терять их" },
  { id: "show_offer", label: "Показать услуги и цены" },
  { id: "fill_schedule", label: "Заполнить расписание" },
  { id: "reduce_no_shows", label: "Меньше неявок и отмен в последний момент" },
  { id: "stay_informed", label: "Владелец и сотрудники сразу в курсе" },
  { id: "client_history", label: "История клиента под рукой" },
  { id: "deal_pipeline", label: "Порядок в сделках" },
  { id: "team_work", label: "Разделить работу между сотрудниками" },
  { id: "visibility", label: "Видеть результат в цифрах" },
  { id: "self_service", label: "Клиент сам видит свои записи и заявки" },
  { id: "retention", label: "Удерживать клиентов, продавать пакеты" },
  { id: "resource_tracking", label: "Учёт выдачи: кто что взял и когда вернёт" },
  { id: "sell_online", label: "Продавать товары на сайте" },
] as const;

export type GoalId = (typeof GOALS)[number]["id"];
export const GOAL_IDS = GOALS.map((g) => g.id) as unknown as readonly [GoalId, ...GoalId[]];
export const goalIdSchema = z.enum(GOAL_IDS);

const LABELS: ReadonlyMap<string, string> = new Map(GOALS.map((g) => [g.id, g.label]));
/** Russian label of a goal id (the id itself when unknown). */
export const goalLabel = (id: string): string => LABELS.get(id) ?? id;
