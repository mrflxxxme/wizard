// The critic of the block pipeline (V5-03, D80 (6)): the same screenshots 390/1440 as the page critic, but the edits are
// slot values of the director's blocks (no free code): a text, a variant. The pipeline applies them, checks the slots
// against the catalog and the bans, and asks again — at most two rounds.
import type { LlmAttachment, LlmMessage } from "@wizard/llm";
import { z } from "zod";
import { defineTool } from "../../../core/tool.js";
import { shotLegend } from "./prompt.js";
import type { CriticShot } from "./types.js";

export const SLOT_CRITIC_TOOL = "submit_slot_edits";
/** Rounds at most (D80 (6)). */
export const SLOT_CRITIC_ROUNDS = 2;

const edit = z.strictObject({
  /** Index of the block in blocks[] (from the outline). */
  block: z.number().int().min(0).max(12),
  /** Dot path inside the block's content («title», «items.1.text»); «variant» — the block's variant id. */
  path: z.string().trim().min(1).max(80),
  value: z.union([z.string().max(400), z.number()]),
  why: z.string().trim().min(3).max(200),
});
export type SlotEdit = z.output<typeof edit>;

export const slotCritiqueSchema = z.strictObject({
  /** 0–100 overall impression of the page against the grill-11 bar. */
  score: z.number().min(0).max(100),
  verdict: z.string().trim().min(3).max(300),
  edits: z
    .array(edit)
    .max(8)
    .default(() => []),
});
export type SlotCritique = z.output<typeof slotCritiqueSchema>;

export const slotCritiqueTool = (
  check?: (v: SlotCritique) => { path: string; code: string; message: string }[],
) =>
  defineTool({
    name: SLOT_CRITIC_TOOL,
    description: "Verdict on the page and the slot edits that fix what the screenshots show.",
    input: slotCritiqueSchema,
    ...(check ? { check } : {}),
  });

const SYSTEM = [
  "Ты — арт-критик сайта из готовых блоков. Смотри на снимки (390 и 1440 px) и правь только слоты блоков.",
  "Ищи: заголовок не помещается или рвётся, пустоты и слипание, слабый контраст, текст без голоса и без цифры, повторы в соседних блоках.",
  "Не предлагай новых блоков, кода и красок. Правка — один слот: путь внутри content и новое значение на русском в пределах лимита слота.",
  "Запрещено навсегда: тире-вставки, «не X, а Y», тройки прилагательных, «мы заботимся», обещания без цифр.",
  `Ответ — только вызов ${SLOT_CRITIC_TOOL}. Нет что править — edits пустой.`,
].join("\n");

/** One line per block: index, id, variant, slots with their current values. */
export function slotOutline(
  blocks: readonly { id: string; variant?: string; content: Record<string, unknown> }[],
) {
  return blocks
    .map(
      (b, i) =>
        `${i}. ${b.id}${b.variant ? ` [${b.variant}]` : ""}: ${JSON.stringify(b.content).slice(0, 700)}`,
    )
    .join("\n");
}

export function slotCritiqueMessages(o: {
  name: string;
  tone: string;
  blocks: readonly { id: string; variant?: string; content: Record<string, unknown> }[];
  shots: readonly CriticShot[];
  history: readonly string[];
}): LlmMessage[] {
  const text = [
    `Сайт: ${o.name}. Тон: ${o.tone}.`,
    "Блоки страницы (индекс, id, слоты):",
    slotOutline(o.blocks),
    ...o.history,
    "Изображения:",
    ...o.shots.map(shotLegend),
  ].join("\n");
  const attachments: LlmAttachment[] = o.shots.map((s, i) => ({
    mime: s.mime,
    data: s.data,
    name: `${i + 1}-${s.width}-${s.kind}.jpg`,
  }));
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: text, attachments },
  ];
}

/** Sets `value` at the dot path of `content` (a copy); false when the path does not lead to an existing slot. */
export function setSlot(content: Record<string, unknown>, path: string, value: string | number): boolean {
  const keys = path.split(".");
  let at: unknown = content;
  for (const k of keys.slice(0, -1)) {
    if (at === null || typeof at !== "object") return false;
    at = (at as Record<string, unknown>)[k];
  }
  const last = keys[keys.length - 1] as string;
  if (at === null || typeof at !== "object" || !(last in (at as object))) return false;
  const cur = (at as Record<string, unknown>)[last];
  if (typeof cur !== typeof value || (typeof cur === "object" && cur !== null)) return false;
  (at as Record<string, unknown>)[last] = value;
  return true;
}
