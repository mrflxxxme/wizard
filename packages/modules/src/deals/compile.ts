// compile.ts of «Воронка сделок» (manifest.hook): the deal status from the plan's stages — canonical values
// stage_1…stage_N in the plan's order plus won and lost (the metrics, the funnel function and the scenarios rely on
// them) — the optional amount, the person in charge and tasks, and a G1 scenario that a deal moves to the next stage.
import type { Field, ModuleFragments } from "@wizard/appspec";
import { leadSampleData } from "../client_card/compile.js";
import type { ModuleContext } from "../types.js";

/** Final stages the module adds after the plan's stages. */
export const DEAL_FINAL_STAGES = [
  { value: "won", label: "Успешно" },
  { value: "lost", label: "Отказ" },
] as const;
/** Stages when the plan left the list empty. */
const DEFAULT_STAGES = ["Новая"];

/** Status options of a deal: stage_1…stage_N with the plan's labels, then won and lost. */
export function dealStages(stages: readonly string[]): { value: string; label: string }[] {
  const list = stages.length ? stages : DEFAULT_STAGES;
  return [
    ...list.map((label, i) => ({
      value: `stage_${i + 1}`,
      label: label.trim().slice(0, 80) || `Этап ${i + 1}`,
    })),
    ...DEAL_FINAL_STAGES.map((s) => ({ ...s })),
  ];
}

const assignee: Field = {
  name: "assignee",
  label: "Ответственный",
  type: "ref",
  ref: { entity: "users", onDelete: "set_null" },
};

export function compileDeals(ctx: ModuleContext): ModuleFragments {
  const stages = dealStages((ctx.params.stages as string[] | undefined) ?? []);
  const withAssignees = Boolean(ctx.params.assignees);
  const fields: Field[] = [
    { name: "title", label: "Название", type: "string", required: true, maxLength: 200 },
    {
      name: "status",
      label: "Этап",
      type: "enum",
      required: true,
      default: "stage_1",
      enum: stages,
    },
  ];
  if (ctx.params.with_amount) fields.push({ name: "amount", label: "Сумма", type: "money", min: 0 });
  if (withAssignees) fields.push({ ...assignee });
  const out: ModuleFragments = {
    entities: [
      {
        value: {
          name: "deal",
          label: ctx.params.deal_label,
          fields,
          indexes: [{ fields: ["status"] }],
        },
      },
    ],
  };
  if (ctx.params.with_tasks)
    out.entities?.push({
      value: {
        name: "deal_task",
        label: "Задача",
        fields: [
          {
            name: "deal",
            label: String(ctx.params.deal_label),
            type: "ref",
            required: true,
            ref: { entity: "deal", onDelete: "cascade" },
          },
          { name: "title", label: "Что сделать", type: "string", required: true, maxLength: 200 },
          { name: "due_at", label: "Срок", type: "datetime", required: true },
          { name: "done", label: "Сделано", type: "bool", required: true, default: false },
          ...(withAssignees ? [{ ...assignee }] : []),
        ],
        indexes: [{ fields: ["done", "due_at"] }],
      },
    });
  const next = stages[1]?.value ?? "won";
  out.acceptance = [
    {
      value: {
        text: "Сделка переходит с первого этапа на следующий",
        check: {
          type: "scenario",
          steps: [
            { as: { role: "owner" } },
            { create: { entity: "deal", data: { title: "Пример сделки" }, save: "deal" } },
            { read: { entity: "deal", id: "$deal.id" } },
            { expect: { fields: { status: "stage_1" } } },
            { update: { entity: "deal", id: "$deal.id", data: { status: next } } },
            { read: { entity: "deal", id: "$deal.id" } },
            { expect: { fields: { status: next } } },
          ],
        },
      },
    },
  ];
  const lead = ctx.present.has("leads") && ctx.allParams.leads ? leadSampleData(ctx.allParams.leads) : null;
  if (lead)
    out.acceptance.push({
      value: {
        text: "Заявка, взятая в работу, становится сделкой на первом этапе",
        check: {
          type: "scenario",
          steps: [
            { create: { entity: "lead", data: lead, save: "lead" }, consent: true },
            { as: { role: "owner" } },
            { update: { entity: "lead", id: "$lead.id", data: { status: "in_work" } } },
            { runWorkflows: {} },
            { read: { entity: "deal", where: { lead: "$lead.id" } } },
            { expect: { count: 1, fields: { status: "stage_1" } } },
          ],
        },
      },
    });
  return out;
}
