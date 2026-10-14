// V4-15 «Укажи и измени» for v3 systems (D79 (9), builder.yaml#point_and_edit): the owner clicked an element of the
// preview and said what to change — one model call rewrites only the file of that element (a page of the composer or
// a free TSX page), ≤ 60 s. The answer is checked here (it parses, keeps the file's imports and data bindings, no raw
// colours or fonts) and by the platform's gates after the commit; their problems go back to the model once.
import type { LlmMessage, OrgPolicy, RouteContext } from "@wizard/llm";
import ts from "typescript";
import { z } from "zod";
import type { RunStepFn } from "../../../core/events.js";
import { callTool, type RouteFn } from "../../../core/loop.js";
import { defineTool, type ToolIssue } from "../../../core/tool.js";

/** The point edit uses the page writer's route (the same model writes the pages). */
export const POINT_EDIT_CALL_TYPE = "page_compose" as const;
export const POINT_EDIT_MAX_FILE = 48_000;

export interface PointEditTarget {
  file: string;
  line: number;
  componentName: string;
  route: string;
  instruction: string;
}

export interface PointEditInput {
  target: PointEditTarget;
  /** The file as it is now. */
  source: string;
  /** V4-24: a section written as code — its props as the page file passes them (texts and photos live there). */
  props?: string;
  /** Problems of the platform's gates on the previous answer (the repair round). */
  problems?: readonly string[];
}

const ROLE = `Ты — разработчик сайта на React и Tailwind. Владелец кликнул по элементу превью и попросил его изменить.
Перепиши ТОЛЬКО этот файл и верни его целиком инструментом submit_file.`;

const RULES = `Правила:
- Меняй только то, о чём просит владелец, и только в области выбранного элемента (строка отмечена ▶). Остальной файл оставь как есть.
- Импорты не добавляй, кроме секций библиотеки из ../../patterns/<id>. Не трогай привязки к данным: entity, href, path, action, формы и их поля.
- Цвета, шрифты, отступы и скругления — только классами токенов дизайн-системы (bg-surface, text-ink, text-accent, rounded-md, gap-4…); никаких #hex, rgb(), font-family и style с цветом.
- Тексты — по-русски, без выдуманных фактов, цен и цифр, которых нет в файле или в просьбе.
- Файл должен остаться корректным TSX с export default.`;

function numbered(source: string, line: number): string {
  return source
    .split("\n")
    .map((l, i) => `${i + 1 === line ? "▶" : " "}${String(i + 1).padStart(4)} ${l}`)
    .join("\n");
}

export function pointEditMessages(i: PointEditInput): LlmMessage[] {
  const t = i.target;
  const user = [
    `Файл: ${t.file} (страница ${t.route}). Выбранный элемент: ${t.componentName || "элемент"}, строка ${t.line}.`,
    `Просьба владельца: ${t.instruction}`,
    ...(i.problems?.length
      ? [
          `Проверка прошлого варианта нашла ошибки — исправь их:\n${i.problems.map((p) => `- ${p}`).join("\n")}`,
        ]
      : []),
    ...(i.props
      ? [
          `Это секция страницы: её тексты и фото приходят в props из файла страницы. Меняй вёрстку и оформление здесь; если владелец просит другой текст — впиши его прямо в разметку вместо поля props. Props секции сейчас: ${i.props}`,
        ]
      : []),
    "Файл сейчас:",
    numbered(i.source, t.line),
  ].join("\n\n");
  return [
    { role: "system", content: `${ROLE}\n\n${RULES}` },
    { role: "user", content: user },
  ];
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function imports(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements)
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier))
      out.add(st.moduleSpecifier.text);
  return out;
}

const BINDING_RE = /"(?:entity|path)"\s*:\s*"([^"]+)"|\b(?:entity|path)="([^"]+)"/g;
const bindings = (text: string) => new Set([...text.matchAll(BINDING_RE)].map((m) => m[1] ?? m[2]));
const RAW_STYLE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|font-family|fontFamily/g;

/** Checks of a rewritten file against the one it replaces. */
export function pointEditIssues(file: string, before: string, after: string): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const sf = parse(file, after) as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] };
  if (sf.parseDiagnostics?.length)
    issues.push({
      path: "content",
      message: `TSX не разбирается: ${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0]?.messageText ?? "", " ")}`,
    });
  if (!/export\s+default\b/.test(after))
    issues.push({ path: "content", message: "Нужен export default компонента страницы" });
  const was = imports(parse(file, before));
  for (const m of imports(sf))
    if (!was.has(m) && !/^\.\.\/\.\.\/patterns\/[a-z0-9-]+$/.test(m))
      issues.push({
        path: "content",
        message: `Новый импорт «${m}» запрещён: используй импорты файла или секции ../../patterns/<id>`,
      });
  const kept = bindings(after);
  for (const b of bindings(before))
    if (!kept.has(b))
      issues.push({ path: "content", message: `Привязка к данным «${b}» пропала — верни её` });
  const rawBefore = new Set(before.match(RAW_STYLE) ?? []);
  for (const raw of new Set(after.match(RAW_STYLE) ?? []))
    if (!rawBefore.has(raw))
      issues.push({
        path: "content",
        message: `«${raw}» — сырые цвета и шрифты запрещены, используй токены`,
      });
  if (after.trim() === before.trim())
    issues.push({ path: "content", message: "Файл не изменился — выполни просьбу владельца" });
  return issues;
}

export type PointEditResult = { ok: true; source: string; summary: string } | { ok: false; reason: string };

/** One structured call: the rewritten file, checked; null route — nothing to do. */
export async function pointEditV3(o: {
  input: PointEditInput;
  route: RouteFn;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  runStep?: RunStepFn;
  signal?: AbortSignal;
}): Promise<PointEditResult> {
  const { target, source } = o.input;
  const tool = defineTool({
    name: "submit_file",
    description: "The whole rewritten file and one short Russian sentence of what changed.",
    input: z.object({
      content: z.string().min(1).max(POINT_EDIT_MAX_FILE),
      summary: z.string().min(1).max(300),
    }),
    check: (v) => pointEditIssues(target.file, source, v.content),
  });
  const r = await callTool({
    route: o.route,
    callType: POINT_EDIT_CALL_TYPE,
    orgPolicy: o.orgPolicy ?? null,
    ctx: o.ctx ?? { orgId: "host" },
    ...(o.runStep ? { runStep: o.runStep } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    stepName: "point_edit",
    messages: pointEditMessages(o.input),
    tool,
    maxRepairs: 1,
    textArgs: true,
  });
  if (!r.ok)
    return {
      ok: false,
      reason: r.issues
        .map((i) => i.message)
        .join("; ")
        .slice(0, 500),
    };
  return { ok: true, source: r.value.content, summary: r.value.summary };
}

/** Folder of the sections written as code (compose/site.ts SECTIONS_DIR). */
const SECTIONS_DIR = "ui/sections/";

/**
 * V4-24: the owner pointed at a section written as code (its element on the page file, wrapped with data-wz-id by the
 * build): the edit goes to the section's own file (ui/sections/<page>-<id>.tsx), with the props the page passes it.
 * null — the element is not such a section (a pattern, a free page): the page file is the target as before.
 */
export function codeSectionTarget(
  target: PointEditTarget,
  pageSource: string,
): { target: PointEditTarget; props: string } | null {
  const sf = parse(target.file, pageSource);
  let file: string | null = null;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.importClause?.name?.text !== target.componentName) continue;
    const dir = target.file.split("/").slice(0, -1);
    for (const part of st.moduleSpecifier.text.split("/")) {
      if (part === "..") dir.pop();
      else if (part !== ".") dir.push(part);
    }
    const path = `${dir.join("/")}.tsx`;
    if (path.startsWith(SECTIONS_DIR)) file = path;
  }
  if (!file) return null;
  // The props of the element the owner chose: its line (the first one of the component when the line is off).
  const els: { line: number; props: string }[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === target.componentName
    ) {
      const spread = n.attributes.properties.find(ts.isJsxSpreadAttribute);
      els.push({
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        props: spread ? spread.expression.getText(sf) : "{}",
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const el = els.find((e) => e.line === target.line) ?? els[0];
  return { target: { ...target, file, line: 1 }, props: (el?.props ?? "{}").slice(0, 6000) };
}
