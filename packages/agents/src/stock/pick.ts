// V4-10 (D79 (6)): the vision model picks the site's photos (photo_pick, models.yaml#routes.photo_pick): the numbered
// 480 px copies of up to 20 library candidates, the slots with their orientation, the niche, the photo style and the
// direction's colours → one photo per slot by meaning (it shows this business, people and places that fit) and by
// palette (it sits with the colours, the photos look like one shoot). Stock photos carry no personal data. Any failure
// returns null: the photos stage then takes the candidates in rank order.
import type { LlmAttachment, LlmMessage, OrgPolicy, RouteContext } from "@wizard/llm";
import { z } from "zod";
import type { RunStepFn } from "../core/events.js";
import { callTool, type RouteFn } from "../core/loop.js";
import { defineTool, type ToolIssue } from "../core/tool.js";
import type { PhotoPicker, PickInput } from "./photos.js";

export const PHOTO_PICK_CALL_TYPE = "photo_pick" as const;

const ORIENTATION_RU = {
  landscape: "горизонтальное",
  portrait: "вертикальное",
  square: "квадратное",
} as const;

const SYSTEM = [
  "Ты фоторедактор сайта малого бизнеса. Тебе показывают пронумерованные фото-кандидаты и места на сайте.",
  "Для каждого места выбери одно фото:",
  "1) по смыслу — на фото именно этот бизнес, его место, люди за работой или результат; без случайных сюжетов (деньги у клининга, офис у кондиционеров);",
  "2) по палитре — фото сочетается с цветами направления, все фото сайта выглядят как одна съёмка;",
  "3) ориентация фото совпадает с местом; одно фото — на одно место;",
  "4) без надписей, вывесок, логотипов и водяных знаков в кадре; не учебный класс, не выставка и не ряд одинаковых рабочих мест — нужен один кабинет, мастер или результат, как у этого бизнеса.",
  "Если подходящего фото для места нет, не выбирай ничего для него. Ответ — вызов инструмента submit_photos.",
].join("\n");

/** Type of an image by its signature (the library serves WebP; a probe may pass JPEG or PNG). */
const imageMime = (b: Uint8Array): "image/webp" | "image/jpeg" | "image/png" =>
  b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png" : "image/webp";

/** The request: the rules, then one message with the site, the places and the numbered pictures. */
export function photoPickMessages(input: PickInput): LlmMessage[] {
  const orient = (e: { width: number; height: number }) => {
    const r = e.width / e.height;
    return r >= 1.15 ? "горизонтальное" : r <= 0.9 ? "вертикальное" : "квадратное";
  };
  const text = [
    `Бизнес: ${input.niche}.`,
    input.style ? `Стиль фото: ${input.style}.` : "",
    input.palette.length ? `Цвета направления: ${input.palette.join(", ")}.` : "",
    "",
    "Места на сайте:",
    ...input.slots.map((s) => `- ${s.slot}: ${s.label}, ${ORIENTATION_RU[s.orientation]}`),
    "",
    "Кандидаты (номер — изображение по порядку):",
    ...input.candidates.map((c, i) => `${i + 1}. ${orient(c.entry)}, средний цвет ${c.entry.color}`),
  ]
    .filter((l, i, xs) => l !== "" || (i > 0 && xs[i - 1] !== ""))
    .join("\n");
  const attachments: LlmAttachment[] = input.candidates.map((c, i) => {
    const mime = imageMime(c.thumbnail);
    return { mime, data: Buffer.from(c.thumbnail).toString("base64"), name: `${i + 1}.${mime.slice(6)}` };
  });
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: text, attachments },
  ];
}

const pickSchema = z.object({
  choices: z
    .array(z.object({ slot: z.string().min(1).max(40), photo: z.number().int().min(1).max(99) }))
    .max(20),
});

/** submit_photos: slot → candidate number; unknown slots and numbers, and a photo twice, are issues for the model. */
export function photoPickTool(input: Pick<PickInput, "slots" | "candidates">) {
  const slots = new Set(input.slots.map((s) => s.slot));
  return defineTool({
    name: "submit_photos",
    description:
      "One candidate photo (1-based number) per site slot; a slot without a fitting photo is left out.",
    input: pickSchema,
    check: (v): ToolIssue[] => {
      const issues: ToolIssue[] = [];
      const seen = new Set<number>();
      v.choices.forEach((c, i) => {
        if (!slots.has(c.slot))
          issues.push({ path: `choices.${i}.slot`, code: "UNKNOWN_SLOT", message: `Нет места ${c.slot}.` });
        if (c.photo > input.candidates.length)
          issues.push({ path: `choices.${i}.photo`, code: "UNKNOWN_PHOTO", message: `Нет фото ${c.photo}.` });
        if (seen.has(c.photo))
          issues.push({
            path: `choices.${i}.photo`,
            code: "DUPLICATE",
            message: `Фото ${c.photo} уже выбрано.`,
          });
        seen.add(c.photo);
      });
      return issues;
    },
  });
}

/** The picker over a route (the build's wallet): one structured call, null on any failure. */
export function modelPhotoPicker(o: {
  route: RouteFn;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  runStep?: RunStepFn;
  signal?: AbortSignal;
}): PhotoPicker {
  return async (input) => {
    if (input.candidates.length === 0 || input.slots.length === 0) return null;
    try {
      const r = await callTool({
        route: o.route,
        callType: PHOTO_PICK_CALL_TYPE,
        orgPolicy: o.orgPolicy ?? null,
        ctx: o.ctx ?? { orgId: "host" },
        ...(o.runStep ? { runStep: o.runStep } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        stepName: PHOTO_PICK_CALL_TYPE,
        messages: photoPickMessages(input),
        tool: photoPickTool(input),
        maxRepairs: 1,
      });
      if (!r.ok) return null;
      return r.value.choices.map((c) => ({ slot: c.slot, index: c.photo - 1 }));
    } catch (e) {
      if (o.signal?.aborted) throw e;
      return null;
    }
  };
}
