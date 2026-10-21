// The roles of the chain (V5-03): each is one tool call whose answer code checks before the next role reads it.
import { type LlmMessage, modelFamilyOf, type Registry, type RouteInput } from "@wizard/llm";
import {
  type BlockSpec,
  blocksOf,
  contentErrors,
  DIRECTIONS,
  type DirectionId,
  paletteBanErrors,
} from "@wizard/ui-kit";
import { lintPattern } from "@wizard/ui-kit/v3/patterns";
import { type CallBase, callTool, type RouteFn } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { concreteShare, slopIssues } from "./antislop.js";
import {
  copywriterMessages,
  directorMessages,
  editorMessages,
  judgeMessages,
  type RolesInput,
  signatureMessages,
  strategistMessages,
  TOOLS,
} from "./prompts.js";
import {
  type BlocksPage,
  blocksSchema,
  type Copy,
  copySchema,
  editedSchema,
  judgeSchema,
  type Positioning,
  positioningSchema,
  type SignatureCandidate,
  signatureCandidateSchema,
} from "./types.js";

export type RoleBase = Omit<CallBase, "callType">;

const issue = (path: string, code: string, message: string): ToolIssue => ({ path, code, message });

/** A route whose calls skip the given model families (an editor and a judge are never of their author's). */
export const avoiding =
  (route: RouteFn, families: readonly (string | null)[]): RouteFn =>
  (input: RouteInput) => {
    const f = families.filter((x): x is string => !!x);
    return route(f.length ? { ...input, avoidFamilies: [...(input.avoidFamilies ?? []), ...f] } : input);
  };

/** A route that remembers the model of its last answer. */
export function tracking(route: RouteFn): { route: RouteFn; model: () => string | null } {
  let last: string | null = null;
  return {
    route: async (input) => {
      const out = await route(input);
      last = out.model;
      return out;
    },
    model: () => last,
  };
}

export const familyOf = (r: Registry, model: string | null): string | null =>
  model ? modelFamilyOf(r, model) : null;

/** Catalog of a direction. */
export const catalogOf = (d: DirectionId): readonly BlockSpec[] => blocksOf(d).map((b) => b.spec);

const slopTool = (v: unknown) =>
  slopIssues(v)
    .slice(0, 8)
    .map((h) =>
      issue(
        "",
        "SLOP",
        `Штамп «${h.text.slice(0, 80)}» — ${h.why}. Перепиши конкретно, с фактом или числом.`,
      ),
    );

export async function strategist(base: RoleBase, input: RolesInput): Promise<Positioning | null> {
  const tool = defineTool({
    name: TOOLS.positioning,
    description: "Positioning, USP and the sitemap of the site.",
    input: positioningSchema,
    check: (v) => {
      const out = slopTool(v);
      const ids = v.sitemap.map((s) => s.id);
      if (ids[0] !== "header" && !ids[0]?.startsWith("header"))
        out.push(issue("sitemap", "ORDER", "Первый раздел — шапка (id header)."));
      if (!ids[1]?.startsWith("hero"))
        out.push(issue("sitemap", "ORDER", "Второй раздел — первый экран (id hero)."));
      if (!ids[ids.length - 1]?.startsWith("footer"))
        out.push(issue("sitemap", "ORDER", "Последний раздел — подвал (id footer)."));
      if (new Set(ids).size !== ids.length) out.push(issue("sitemap", "DUP", "id разделов повторяются."));
      if (![...v.usp, ...v.proof].some((s) => /\d/.test(s)))
        out.push(
          issue(
            "usp",
            "NO_FIGURE",
            "Ни в УТП, ни в доказательствах нет числа из входа: возьми срок, цену, год, рейтинг или объём.",
          ),
        );
      return out;
    },
  });
  const r = await callTool({
    ...base,
    callType: "role_strategist",
    stepName: "roles:strategist",
    messages: strategistMessages(input),
    tool,
  });
  return r.ok ? r.value : null;
}

export async function copywriter(base: RoleBase, input: RolesInput, p: Positioning): Promise<Copy | null> {
  const tool = defineTool({
    name: TOOLS.copy,
    description: "All texts of the page by the sitemap.",
    input: copySchema,
    check: (v) => {
      const out = slopTool(v);
      const want = p.sitemap.map((s) => s.id).join(",");
      if (v.sections.map((s) => s.id).join(",") !== want)
        out.push(issue("sections", "IDS", `Разделы должны идти ровно по карте сайта: ${want}.`));
      return out;
    },
  });
  const r = await callTool({
    ...base,
    callType: "role_copywriter",
    stepName: "roles:copywriter",
    messages: copywriterMessages(input, p),
    tool,
  });
  return r.ok ? r.value : null;
}

/** The editor never leaves a code-found phrase: the tool refuses its answer and it repairs (callTool). */
export async function editor(
  base: RoleBase,
  p: Positioning,
  c: Copy,
): Promise<{ copy: Copy; changes: string[] } | null> {
  const hits = slopIssues(c)
    .slice(0, 12)
    .map((h) => `- «${h.text.slice(0, 90)}» — ${h.why}`)
    .join("\n");
  const tool = defineTool({
    name: TOOLS.edited,
    description: "The edited copy and the list of changes.",
    input: editedSchema,
    check: (v) => {
      const out = slopTool(v.copy);
      if (v.copy.sections.map((s) => s.id).join(",") !== c.sections.map((s) => s.id).join(","))
        out.push(issue("copy.sections", "IDS", "id и порядок разделов менять нельзя."));
      // The edit must not make the page vaguer than it was.
      if (concreteShare(v.copy) + 0.05 < concreteShare(c))
        out.push(
          issue("copy", "VAGUER", "После правки в тексте меньше цифр и фактов, чем было: верни конкретику."),
        );
      return out;
    },
  });
  const r = await callTool({
    ...base,
    callType: "role_editor",
    stepName: "roles:editor",
    messages: editorMessages(p, c, hits),
    tool,
  });
  return r.ok ? { copy: r.value.copy, changes: r.value.changes } : null;
}

const photoSrcs = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) for (const x of v) photoSrcs(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.src === "string" && "credit" in o) out.push(o.src);
    for (const x of Object.values(o)) photoSrcs(x, out);
  }
  return out;
};

/** Checks of a page of blocks against the catalog, the section order, the photo pool and the bans. */
export function pageIssues(v: BlocksPage, photos: readonly { src: string }[], p?: Positioning): ToolIssue[] {
  const out: ToolIssue[] = [];
  const specs = new Map(catalogOf(v.direction).map((s) => [s.id, s]));
  const pool = new Set(photos.map((x) => x.src));
  v.blocks.forEach((b, i) => {
    const spec = specs.get(b.id);
    if (!spec) {
      out.push(
        issue(
          `blocks.${i}.id`,
          "UNKNOWN_BLOCK",
          `Блока «${b.id}» нет в каталоге направления ${v.direction}.`,
        ),
      );
      return;
    }
    if (b.variant && !spec.variants.some((x) => x.id === b.variant))
      out.push(
        issue(
          `blocks.${i}.variant`,
          "VARIANT",
          `У «${b.id}» нет варианта «${b.variant}»: ${spec.variants.map((x) => x.id).join(", ")}.`,
        ),
      );
    for (const e of contentErrors(b.id, b.content))
      out.push(issue(`blocks.${i}.content`, "SLOT", `${b.id}: ${e}`));
    for (const s of photoSrcs(b.content))
      if (!pool.has(s))
        out.push(issue(`blocks.${i}.content`, "PHOTO", `${b.id}: фото ${s} нет в списке фото.`));
  });
  const sections = v.blocks.map((b) => specs.get(b.id)?.section);
  if (sections[0] !== "header") out.push(issue("blocks.0", "ORDER", "Первым идёт блок-шапка."));
  if (sections[1] !== "hero") out.push(issue("blocks.1", "ORDER", "Вторым идёт блок первого экрана."));
  if (sections[sections.length - 1] !== "footer")
    out.push(issue("blocks", "ORDER", "Последним идёт подвал."));
  if (new Set(v.blocks.map((b) => b.id)).size !== v.blocks.length)
    out.push(issue("blocks", "DUP", "Один блок дважды."));
  if (p && v.direction !== p.direction)
    out.push(issue("direction", "DIRECTION", `Направление ${p.direction}, как выбрал стратег.`));
  out.push(...slopTool(v.blocks));
  return out;
}

export async function director(
  base: RoleBase,
  input: RolesInput,
  p: Positioning,
  c: Copy,
): Promise<BlocksPage | null> {
  const tool = defineTool({
    name: TOOLS.blocks,
    description: "The page as blocks of the catalog.",
    input: blocksSchema,
    check: (v) => pageIssues(v, input.photos, p),
  });
  const r = await callTool({
    ...base,
    callType: "role_director",
    stepName: "roles:director",
    messages: directorMessages(input, p, c, catalogOf(p.direction)),
    tool,
    maxRepairs: 3,
  });
  if (!r.ok) return null;
  const ban = paletteBanErrors(
    DIRECTIONS[r.value.direction].design,
    DIRECTIONS[r.value.direction].brandChoice,
  );
  return ban.length ? null : r.value;
}

const ALLOWED_IMPORT = /^(react|motion\/react|@wizard\/ui-kit)$/;

/** Problems of a signature section's TSX. */
export function signatureSourceIssues(source: string): ToolIssue[] {
  const out: ToolIssue[] = [];
  if (!/export\s+default\s+function\s+\w*\s*\(\s*\)/.test(source))
    out.push(issue("source", "DEFAULT", "Нужен `export default function Имя()` без props."));
  for (const m of source.matchAll(/from\s+["']([^"']+)["']/g))
    if (!ALLOWED_IMPORT.test(m[1] as string))
      out.push(
        issue("source", "IMPORT", `Импорт «${m[1]}» не разрешён: react, motion/react, @wizard/ui-kit.`),
      );
  if (/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/.test(source))
    out.push(issue("source", "RAW_COLOR", "Сырые цвета запрещены: токены темы."));
  // Texts in the code are the point of a signature section (facts of the positioning); every other pattern rule holds.
  for (const i of lintPattern(source, "v5-signature.tsx").filter((x) => x.code !== "fabricated"))
    out.push(issue("source", `PATTERN_${i.code}`, `${i.message_ru}${i.evidence ? `: ${i.evidence}` : ""}`));
  const strings = [...source.matchAll(/>([^<>{}]{6,})</g)].map((m) => m[1] as string);
  out.push(...slopTool(strings));
  return out;
}

export async function signatureCandidate(
  base: RoleBase,
  callOpts: { stepName: string },
  p: Positioning,
  page: BlocksPage,
): Promise<SignatureCandidate | null> {
  const specs = new Map(catalogOf(page.direction).map((s) => [s.id, s]));
  const after = page.blocks.map((b) => ({ id: b.id, section: specs.get(b.id)?.section ?? "?" }));
  const tokens = [...new Set([...specs.values()].flatMap((s) => s.tokens))];
  const tool = defineTool({
    name: TOOLS.signature,
    description: "One signature section as TSX.",
    input: signatureCandidateSchema,
    check: (v) => [
      ...signatureSourceIssues(v.source),
      ...(after.some((b) => b.id === v.after)
        ? []
        : [issue("after", "AFTER", "after — id одного из блоков страницы.")]),
    ],
  });
  const r = await callTool({
    ...base,
    callType: "signature_section",
    stepName: callOpts.stepName,
    messages: signatureMessages(p, after, tokens, DIRECTIONS[page.direction].signature.moment),
    tool,
  });
  return r.ok ? r.value : null;
}

export async function judge(
  base: RoleBase,
  p: Positioning,
  a: SignatureCandidate,
  b: SignatureCandidate,
): Promise<"A" | "B" | null> {
  const tool = defineTool({
    name: TOOLS.judge,
    description: "Pick the better signature section.",
    input: judgeSchema,
  });
  const r = await callTool({
    ...base,
    callType: "role_judge",
    stepName: "roles:judge",
    messages: judgeMessages(p, a.source, b.source) as LlmMessage[],
    tool,
  });
  return r.ok ? r.value.pick : null;
}
