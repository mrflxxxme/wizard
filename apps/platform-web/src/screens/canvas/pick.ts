// «Ткни и скажи» (B2-29, grill-7 #4): a picked canvas block → the hints the chat offers for it and the plan edits
// each hint sends to PATCH /systems/:id/plan (api.yaml#PlanEdit). Pure: no model, no credits — the server compiles
// the edited plan in milliseconds. A landing section gets «Другой вид» (the next ready variant of its type), «Убрать»
// and «Выше/Ниже»; a module screen gets «Убрать» and toggles of its parameters (bool, enum, enum_list).
import type { PlanEdit, PlanSketch } from "../../api/types.js";
import { canvas } from "../../i18n/ru/canvas.js";
import type { CanvasBlockModel } from "./model.js";

export type HintId = "view" | "remove" | "up" | "down";

export interface Hint {
  id: HintId;
  label: string;
  edits: PlanEdit[];
  /** The line of the client in the chat («Услуги и цены: другой вид»). */
  said: string;
  /** Edits that bring a removed section back («Вернуть»). */
  undo?: PlanEdit[];
}

export interface ParamOption {
  id: string;
  label: string;
  pressed: boolean;
  edits: PlanEdit[];
  said: string;
}

/** One parameter of the block's module: a single switch (bool) or a group of options (enum, enum_list). */
export interface ParamControl {
  module: string;
  param: string;
  label: string;
  kind: "bool" | "enum" | "enum_list";
  options: ParamOption[];
}

export interface BlockActions {
  hints: Hint[];
  params: ParamControl[];
  /** «вид 2 из 3» of a section with several ready variants. */
  variant: { index: number; of: number } | null;
}

/** Larger option lists stay in the chat (e.g. the sections of a staff role): toggles would not fit the row. */
const MAX_OPTIONS = 7;
/** Blocks that stand for the whole site: nothing to remove there. */
const WHOLE_SITE = new Set<CanvasBlockModel["kind"]>(["nav", "mobile"]);

type PlanJson = {
  landing?: { sections?: { type: string; variant: string; content?: Record<string, unknown> }[] };
};

function sectionHints(
  b: CanvasBlockModel,
  sk: PlanSketch,
  index: number,
  plan: Record<string, unknown> | null,
): { hints: Hint[]; variant: BlockActions["variant"] } {
  const hints: Hint[] = [];
  const s = sk.sections.find((x) => x.index === index);
  if (!s) return { hints, variant: null };
  const variants = s.variants ?? [];
  const at = variants.indexOf(s.variant);
  let variant: BlockActions["variant"] = null;
  if (variants.length > 1) {
    const next = variants[(at + 1) % variants.length] as string;
    variant = { index: Math.max(at, 0) + 1, of: variants.length };
    hints.push({
      id: "view",
      label: canvas.pick.hints.view,
      edits: [{ op: "update_section", index, variant: next }],
      said: canvas.pick.said.view(b.title),
    });
  }
  const own = (plan as PlanJson | null)?.landing?.sections?.[index];
  hints.push({
    id: "remove",
    label: canvas.pick.hints.remove,
    edits: [{ op: "remove_section", index }],
    said: canvas.pick.said.remove(b.title),
    ...(own && own.type === s.type
      ? {
          undo: [
            {
              op: "add_section" as const,
              type: own.type,
              variant: own.variant,
              content: structuredClone(own.content ?? {}),
              at: index,
            },
          ],
        }
      : {}),
  });
  const prev = sk.sections.find((x) => x.index === index - 1);
  const next = sk.sections.find((x) => x.index === index + 1);
  if (prev && prev.type !== "header")
    hints.push({
      id: "up",
      label: canvas.pick.hints.up,
      edits: [{ op: "move_section", from: index, to: index - 1 }],
      said: canvas.pick.said.up(b.title),
    });
  if (next && next.type !== "footer")
    hints.push({
      id: "down",
      label: canvas.pick.hints.down,
      edits: [{ op: "move_section", from: index, to: index + 1 }],
      said: canvas.pick.said.down(b.title),
    });
  return { hints, variant };
}

function paramControls(b: CanvasBlockModel, sk: PlanSketch, module: string): ParamControl[] {
  const m = sk.modules.find((x) => x.id === module);
  if (!m) return [];
  const set = (param: string, value: unknown): PlanEdit[] => [{ op: "set_param", module, param, value }];
  return m.params.flatMap((p): ParamControl[] => {
    const said = (what: string) => canvas.pick.said.param(b.title, what);
    if (p.type === "bool") {
      const on = p.value === true;
      return [
        {
          module,
          param: p.name,
          label: p.label,
          kind: "bool",
          options: [
            {
              id: "toggle",
              label: p.label,
              pressed: on,
              edits: set(p.name, !on),
              said: said(`${p.label.toLowerCase()} — ${on ? canvas.pick.off : canvas.pick.on}`),
            },
          ],
        },
      ];
    }
    const opts = p.options ?? [];
    if (opts.length < 2 || opts.length > MAX_OPTIONS) return [];
    if (p.type === "enum")
      return [
        {
          module,
          param: p.name,
          label: p.label,
          kind: "enum",
          options: opts.map((o) => ({
            id: o.value,
            label: o.label,
            pressed: p.value === o.value,
            edits: set(p.name, o.value),
            said: said(`${p.label.toLowerCase()}: ${o.label.toLowerCase()}`),
          })),
        },
      ];
    if (p.type === "enum_list") {
      const cur = Array.isArray(p.value) ? p.value.filter((x): x is string => typeof x === "string") : [];
      return [
        {
          module,
          param: p.name,
          label: p.label,
          kind: "enum_list",
          options: opts.map((o) => {
            const on = cur.includes(o.value);
            // The order of the manifest options, so the same set gives the same plan.
            const value = opts.map((x) => x.value).filter((v) => (v === o.value ? !on : cur.includes(v)));
            return {
              id: o.value,
              label: o.label,
              pressed: on,
              edits: set(p.name, value),
              said: said(`${p.label.toLowerCase()}: ${on ? "без" : "+"} ${o.label.toLowerCase()}`),
            };
          }),
        },
      ];
    }
    return [];
  });
}

/** Hints and parameter toggles of a picked block on a plan sketch (nothing on the interview sketch). */
export function blockActions(
  b: CanvasBlockModel,
  sk: PlanSketch,
  plan: Record<string, unknown> | null = null,
): BlockActions {
  if (sk.stage !== "plan") return { hints: [], params: [], variant: null };
  const index = b.data.sectionIndex;
  if (typeof index === "number") {
    const { hints, variant } = sectionHints(b, sk, index, plan);
    // A section drawn by a module (services → catalog, lead form → leads) shows that module's switches too.
    const params = b.module && b.module !== "landing" ? paramControls(b, sk, b.module) : [];
    return { hints, params, variant };
  }
  const hints: Hint[] = [];
  if (b.module && !WHOLE_SITE.has(b.kind) && b.module !== "landing")
    hints.push({
      id: "remove",
      label: canvas.pick.hints.remove,
      edits: [{ op: "remove_module", module: b.module }],
      said: canvas.pick.said.remove(b.title),
    });
  const params = b.module && b.kind !== "mobile" ? paramControls(b, sk, b.module) : [];
  return { hints, params, variant: null };
}
