// The critic_visual request (V3-13): the rubric of catalog C as the system prompt; the site outline (sections, the
// variants each may take, its texts by path), the tokens that may move, what code already found (not repeated), the
// edits of earlier cycles and the screenshot legend as the user message with the images; the submit_critique tool.
import type { SystemBrief } from "@wizard/appspec";
import type { LlmAttachment, LlmMessage } from "@wizard/llm";
import { archetype, type DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import type { PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { defineTool } from "../../../core/tool.js";
import type { SiteFacts } from "../compose/facts.js";
import type { SiteModel, SitePage } from "../compose/site.js";
import { editOpSchema, variantsFor } from "./ops.js";
import {
  AXIS_RUBRIC,
  CRITIC_AXES,
  critiqueSchema,
  type DeterministicProblem,
  problemDigest,
  WHERE_RE,
} from "./rubric.js";
import type { CriticShot } from "./types.js";

/** callType of the critic (models.yaml#routes.critic_visual; with images the router keeps it on T0). */
export const CRITIC_CALL_TYPE = "critic_visual" as const;

const SYSTEM = [
  "Ты — визуальный критик сайтов малого бизнеса. Перед тобой скриншоты одного сайта: первый экран на телефоне (390) в натуральную величину и вся страница на компьютере (1440), уменьшенная в 4 раза. Оцени его по рубрике и предложи правки. Отвечай только вызовом submit_critique.",
  "Уменьшенный снимок всей страницы — для композиции, ритма, порядка и плотности секций: мелкий текст на нём нечитаем из-за уменьшения, это не дефект сайта. Текст, типографику и кнопки оценивай по снимку телефона.",
  "",
  "Шкала 0–4 по каждой оси: 4 — образцово, 3 — хорошо, 2 — заметные провалы, 1 — серьёзно, 0 — не работает.",
  ...CRITIC_AXES.map((a) => `- ${a} — ${AXIS_RUBRIC[a].label}: ${AXIS_RUBRIC[a].questions}`),
  "polish — проработка: production (можно показывать) или draft; в missing — чего не хватает, словами.",
  "",
  "Находка: sign — признак (id каталога, если есть: L01 три карточки, L04 eyebrow, L05 нумерация, L06 повтор раскладок, L13 перегруженный первый экран, L15 сплит-шапка, C06 лишний акцент, T02 плоская иерархия, T04 раздутый h1, I01 фейковые скриншоты, I05 плашки на фото) и что видно; where — <маршрут>@<ширина>#<id секции> из списка секций; severity — P0 не работает, P1 серьёзно, P2 заметно, P3 мелочь; evidence — номер изображения и область; replace — замена в рамках темы; edit — операция, которая её применяет, или null.",
  "Не принимаются: находка без замены, без видимого признака («не нравится»), мнения о конверсии. Не повторяй то, что уже нашёл код.",
  "",
  "edit — только одна из операций, ничего другого:",
  "- swap_variant {route, section, pattern} — другой вариант секции из её списка «варианты»;",
  "- reorder {route, order} — новый порядок всех секций страницы без header и footer, первый экран остаётся первым;",
  "- set_text {route, section, path, text} — новый текст поля из списка «тексты» секции; факты, числа, цены, сроки и имена — только те, что уже есть на странице (D49); без слов-пустышек, эмодзи и восклицательных знаков;",
  "- token {token, value} — density, radius, display_size (smaller | larger — заголовок первого экрана), muted_contrast (light | dark — второстепенный текст контрастнее); значения — из списка «Токены»;",
  "- drop_section {route, section} — убрать секцию, которой нечего честно сказать (не первый экран, не форма и не данные).",
  "Не больше 6 правок, важные — первыми. Секции с данными (каталог, запись, блог, форма) показаны без записей — их наполнение не оценивай.",
].join("\n");

/** Keys whose strings are not copy (links, sources, bindings). */
const SKIP_KEYS = new Set([
  "href",
  "src",
  "id",
  "icon",
  "value",
  "type",
  "name",
  "entity",
  "booking",
  "categoryEntity",
  "fields",
  "itemAction",
]);

/** String leaves of the props with their dot paths (copy only). */
export function textPaths(props: unknown, prefix = "", out: [string, string][] = []): [string, string][] {
  if (Array.isArray(props)) {
    for (const [i, v] of props.entries()) textPaths(v, prefix ? `${prefix}.${i}` : String(i), out);
  } else if (props && typeof props === "object")
    for (const [k, v] of Object.entries(props)) {
      if (SKIP_KEYS.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") {
        if (v.trim()) out.push([path, v]);
      } else textPaths(v, path, out);
    }
  return out;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The outline of a page: its sections, the variants each may take and its texts by path. */
export function pageOutline(page: SitePage, library: readonly PatternMeta[]): string {
  const lines = [`Страница ${page.route} «${page.title}»:`];
  for (const s of page.sections) {
    const meta = library.find((p) => p.id === s.pattern);
    const parts = [
      `- ${s.id} · ${s.type === "signature" ? `фирменная секция «${s.title ?? s.id}»` : s.pattern}`,
    ];
    if (meta?.needs) parts.push(`данные: ${meta.needs}`);
    const texts =
      s.type === "header" || s.type === "footer" || s.type === "signature" ? [] : textPaths(s.props);
    if (texts.length)
      parts.push(
        `тексты: ${texts
          .slice(0, 6)
          .map(([p, v]) => `${p} «${clip(v, 70)}»`)
          .join("; ")}`,
      );
    const vs = variantsFor(library, s);
    if (vs.length) parts.push(`варианты: ${vs.map((v) => v.id).join(", ")}`);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

/** Tokens the critic may move and their allowed values. */
export function tokenOptions(ds: DesignSystemV3): string {
  const a = archetype(ds.archetype);
  return [
    `density — сейчас ${ds.grid.rhythm.density}, можно: ${(a?.density ?? []).join(", ")}`,
    `radius — сейчас ${ds.radius.set}, можно: ${(a?.radius ?? []).join(", ")}`,
    "display_size — smaller | larger",
    "muted_contrast — light | dark",
  ].join("; ");
}

/** The legend of one screenshot. */
export function shotLegend(s: CriticShot, i: number): string {
  const what =
    s.kind === "page"
      ? "вся страница сверху вниз"
      : `первый экран ${s.width}×${s.width === 390 ? 844 : s.width === 768 ? 1024 : 900}`;
  const scale = s.px.width < s.width ? `, уменьшено до ${s.px.width}×${s.px.height}` : "";
  return `${i + 1}. ${s.route} при ${s.width} px — ${what}${scale}; секции: ${s.sections.join(", ") || "—"}.`;
}

export interface CritiqueHistory {
  cycle: number;
  applied: string[];
  rejected: { edit: string; reason_ru: string }[];
}

export interface CritiqueInput {
  facts: SiteFacts;
  brief: Pick<SystemBrief, "audience" | "goals">;
  site: SiteModel;
  design: DesignSystemV3;
  library: readonly PatternMeta[];
  shots: readonly CriticShot[];
  /** What the deterministic checks found (the model does not repeat it). */
  found: readonly DeterministicProblem[];
  history: readonly CritiqueHistory[];
  stubPhotos?: boolean;
}

/** Messages of a critic_visual call: the rubric and one user message with the images. */
export function critiqueMessages(o: CritiqueInput): LlmMessage[] {
  const routes = [...new Set(o.shots.map((s) => s.route))];
  const pages = o.site.pages.filter((p) => routes.includes(p.route));
  const found = problemDigest(o.found).slice(0, 20);
  const text = [
    `Сайт: ${o.facts.copy.home}.`,
    o.brief.audience ? `Аудитория: ${clip(o.brief.audience, 200)}.` : "",
    o.brief.goals.length ? `Цели: ${o.brief.goals.map((g) => clip(g.text, 100)).join("; ")}.` : "",
    `Стиль: «${o.design.name}» (архетип ${o.design.archetype}), шрифты ${o.design.fonts.display.family} / ${o.design.fonts.text.family}.`,
    `Токены: ${tokenOptions(o.design)}.`,
    "",
    ...pages.map((p) => pageOutline(p, o.library)),
    "",
    found.length
      ? `Уже найдено кодом (не повторяй):\n${found.map((f) => `- ${f.code} ${f.where}: ${clip(f.message_ru, 120)}`).join("\n")}`
      : "Код ничего не нашёл: контраст, переполнение, шрифты, сдвиги вёрстки, тап-цели и заголовки в порядке.",
    ...o.history.map(
      (h) =>
        `Цикл ${h.cycle}: применено — ${h.applied.length ? h.applied.join("; ") : "ничего"}${
          h.rejected.length
            ? `; отклонено — ${h.rejected.map((r) => `${r.edit} (${r.reason_ru})`).join("; ")}`
            : ""
        }.`,
    ),
    "",
    o.stubPhotos
      ? "Фото на скриншотах — заглушки платформы: оценивай место, размер и обработку фото, не сюжет."
      : "",
    "Изображения:",
    ...o.shots.map(shotLegend),
  ]
    .filter((l, i, xs) => l !== "" || (i > 0 && xs[i - 1] !== ""))
    .join("\n");
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

/**
 * Slips of one finding do not cost a repeat with the images: an edit outside the closed set becomes null (the finding
 * stays a note), a finding that does not say where it is is dropped.
 */
function dropBadEdits(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const a = args as { findings?: unknown };
  if (!Array.isArray(a.findings)) return args;
  return {
    ...a,
    findings: a.findings
      .filter(
        (f) =>
          !(
            f &&
            typeof f === "object" &&
            "where" in f &&
            typeof f.where === "string" &&
            !WHERE_RE.test(f.where.trim())
          ),
      )
      .map((f) =>
        f && typeof f === "object" && "edit" in f && f.edit != null && !editOpSchema.safeParse(f.edit).success
          ? { ...f, edit: null }
          : f,
      ),
  };
}

/** submit_critique. */
export const critiqueTool = defineTool({
  name: "submit_critique",
  description:
    "Visual critique by the rubric: axis scores 0-4, polish, findings with closed edit operations.",
  input: critiqueSchema,
  normalize: dropBadEdits,
});
