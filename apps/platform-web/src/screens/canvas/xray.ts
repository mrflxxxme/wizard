// X-ray layer «Как это работает» (B2-25, grill-7 #3): the automation chain of the plan in plain words, anchored to the
// canvas blocks it touches, plus who sees which data and how long it is kept — all from the sketch, no model. Pure.
import type { PlanSketch, SketchAutomation } from "../../api/types.js";
import { canvas } from "../../i18n/ru/canvas.js";
import type { CanvasModel } from "./model.js";

export interface XrayStep {
  id: string;
  label: string;
  /** Canvas block the step sits on. */
  anchor: string;
}

export interface XrayModel {
  steps: XrayStep[];
  edges: [string, string][];
  /** «Владелец» → «Запись, Пациент (только свои)». */
  access: { who: string; what: string }[];
  retention: string[];
  /** Every automation of the plan, in words. */
  automations: string[];
}

const blockOf = (model: CanvasModel, prefer: readonly string[]): string | undefined => {
  const all = [...model.frames.site, ...model.frames.phone, ...model.frames.cab];
  for (const id of prefer) if (all.some((b) => b.id === id)) return id;
  return undefined;
};

const firstOfModule = (model: CanvasModel, frame: "site" | "cab" | "phone", module?: string) =>
  model.frames[frame].find((b) => b.module === module && b.kind !== "nav" && b.kind !== "mobile")?.id;

/** Plain words of one automation: its own label when the module gave one, else its trigger. */
export function automationText(a: SketchAutomation): string {
  if (a.label) return a.label;
  const t = canvas.xray.trigger[a.trigger.type];
  return t ? t(a.trigger.entityLabel ?? "") : a.name;
}

const toClient = (a: SketchAutomation) =>
  a.steps.length > 0 && a.steps.every((s) => s.type === "notify") && a.steps.some((s) => s.to === "client");

export function xrayModel(sk: PlanSketch, model: CanvasModel): XrayModel {
  const autos = sk.automations ?? [];
  const steps: XrayStep[] = [];
  const add = (id: string, label: string, anchor: string | undefined) => {
    if (anchor && !steps.some((s) => s.id === id)) steps.push({ id, label, anchor });
  };
  // 1. What the visitor does on the site starts the chain (a record created by a public module).
  const start = autos.find(
    (a) => a.trigger.type === "on_create" && a.module && firstOfModule(model, "site", a.module),
  );
  if (start) {
    add("start", automationText(start), firstOfModule(model, "site", start.module));
    // 2. The record lands in the cabinet of the same module.
    const cab = firstOfModule(model, "cab", start.module);
    if (cab) add("cabinet", model.frames.cab.find((b) => b.id === cab)?.title ?? "", cab);
  }
  // 3. Reminders before the time (scheduled with an offset) — one step with every offset.
  const offsets = [
    ...new Set(
      autos
        .filter((a) => a.trigger.type === "schedule" && typeof a.trigger.offsetMinutes === "number")
        .map((a) => a.trigger.offsetMinutes as number),
    ),
  ].sort((a, b) => a - b);
  if (offsets.length > 0)
    add("remind", canvas.xray.reminder(offsets), blockOf(model, ["phone:notifications", "cab:schedule"]));
  else {
    const notify = autos.find((a) => a !== start && toClient(a));
    if (notify) add("notify", automationText(notify), blockOf(model, ["phone:notifications"]));
  }
  // 4. The goal panel counts the result.
  add("goals", canvas.xray.goals, blockOf(model, ["cab:goals"]));
  const edges: [string, string][] = [];
  for (let i = 1; i < steps.length; i++) {
    const from = steps[i - 1];
    const to = steps[i];
    if (from && to) edges.push([from.id, to.id]);
  }

  const byRole = new Map<string, string[]>();
  for (const r of sk.access ?? []) {
    const scope = r.scope === "all" ? "" : ` (${canvas.xray.scope[r.scope]})`;
    byRole.set(r.roleLabel, [...(byRole.get(r.roleLabel) ?? []), `${r.entityLabel}${scope}`]);
  }
  return {
    steps,
    edges,
    access: [...byRole].map(([who, what]) => ({ who, what: what.join(", ") })),
    retention: (sk.retention ?? []).map((r) => canvas.xray.keepFor(r.entityLabel, r.days, r.mode)),
    automations: [...new Set(autos.map(automationText))],
  };
}
