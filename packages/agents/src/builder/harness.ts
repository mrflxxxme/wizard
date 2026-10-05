// Harness v2 (agents/builder.yaml#harness): the architect's brief (submit_brief), executor task messages, the wave
// batcher (one routeBatch per wave, deterministic order), the reviewer (submit_review) and stage metrics.
import type { AppSpec } from "@wizard/appspec";
import type { Check, QaCheck } from "@wizard/gates";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import { z } from "zod";
import { defineTool, type ToolIssue } from "../core/index.js";
import { cardDigest, specDigest } from "./digest.js";
import { SDK_FIX_HINT, STUB_MARKER } from "./prompt.js";
import type { BuildCard } from "./types.js";

export const MAX_BRIEF_TASKS = 60;
/** builder.yaml#harness.tasks.limits: model turns per task. */
export const TASK_MAX_TURNS = 4;
/** builder.yaml#harness.tasks.parallel: tasks per wave. */
export const WAVE_SIZE = 3;

export const briefTaskSchema = z.object({
  id: z.string().regex(/^T[1-9]\d*$/),
  kind: z.enum(["lib", "function", "page"]),
  file: z.string().trim().max(200),
  title: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(600),
  details: z.array(z.string().trim().min(1).max(300)).max(12),
  uses: z.array(z.string().trim().min(1).max(80)).max(12),
  acRefs: z.array(z.string().regex(/^AC[1-9]\d*$/)).max(20),
});
export type BriefTask = z.infer<typeof briefTaskSchema>;

export interface BriefScope {
  spec: AppSpec;
  card: BuildCard;
  mode: "create" | "change";
  /** change: files that already hold real code (not a stub) — their tasks are optional. */
  existing: ReadonlySet<string>;
}

/** Semantic checks of the brief (builder.yaml#harness.stages.brief.validate). */
export function briefIssues(tasks: readonly BriefTask[], s: BriefScope): ToolIssue[] {
  const out: ToolIssue[] = [];
  const fns = new Map((s.spec.functions ?? []).map((f) => [f.file, f]));
  const pages = new Map((s.spec.pages ?? []).map((p) => [p.file, p]));
  const fnNames = new Set((s.spec.functions ?? []).map((f) => f.name));
  const entities = new Set((s.spec.entities ?? []).map((e) => e.name));
  const acIds = new Set(s.card.acceptance.map((a) => a.id));
  const seen = new Set<string>();
  const libFiles = new Set(tasks.filter((t) => t.kind === "lib").map((t) => t.file));
  tasks.forEach((t, i) => {
    const at = (k: string) => `tasks.${i}.${k}`;
    if (t.id !== `T${i + 1}`)
      out.push({
        path: at("id"),
        code: "BRIEF_ID",
        message: `Задачи нумеруются по порядку: ожидалась T${i + 1}.`,
      });
    if (t.kind === "lib") {
      if (!LIB_FILE_RE.test(t.file) || fns.has(t.file) || pages.has(t.file))
        out.push({
          path: at("file"),
          code: "BRIEF_FILE",
          message: `Общий модуль — functions/lib/<имя>.ts или ui/components/<Имя>.tsx, не объявленный в спеке: ${t.file}.`,
        });
    } else if (!(t.kind === "function" ? fns.has(t.file) : pages.has(t.file)))
      out.push({
        path: at("file"),
        code: "BRIEF_FILE",
        message: `Файла ${t.file} нет среди объявленных ${t.kind === "function" ? "функций" : "страниц"} спеки.`,
      });
    if (seen.has(t.file))
      out.push({ path: at("file"), code: "BRIEF_DUPLICATE", message: `На файл ${t.file} уже есть задача.` });
    seen.add(t.file);
    for (const u of t.uses) {
      if (libFiles.has(u)) continue;
      // Pages may read and change entities directly (useEntityList/useEntity/useEntityMutation).
      const known = entities.has(u) || fnNames.has(u);
      if (!known)
        out.push({
          path: at("uses"),
          code: "BRIEF_USES",
          message:
            t.kind === "page"
              ? `«${u}» — не функция и не сущность спеки (функции: ${[...fnNames].join(", ") || "нет"}).`
              : `«${u}» — не сущность и не функция спеки.`,
        });
    }
    for (const ac of t.acRefs)
      if (!acIds.has(ac))
        out.push({ path: at("acRefs"), code: "UNKNOWN_AC", message: `Критерия ${ac} нет в карточке.` });
  });
  const required = [...fns.keys(), ...pages.keys()].filter((f) => s.mode === "create" || !s.existing.has(f));
  const missing = required.filter((f) => !seen.has(f));
  if (missing.length)
    out.push({
      path: "tasks",
      code: "BRIEF_COVERAGE",
      message: `Нет задач на объявленные файлы: ${missing.join(", ")}. Нужна ровно одна задача на каждую функцию и страницу.`,
    });
  if (s.mode === "create") {
    const referenced = new Set(tasks.flatMap((t) => t.acRefs));
    const lost = s.card.acceptance.filter((a) => a.check.type !== "permission" && !referenced.has(a.id));
    if (lost.length)
      out.push({
        path: "tasks",
        code: "BRIEF_AC",
        message: `Критерии без задачи: ${lost.map((a) => a.id).join(", ")}. Укажи их в acRefs задач, которые их выполняют.`,
      });
  }
  return out;
}

export function submitBriefTool(scope: BriefScope) {
  return defineTool({
    name: "submit_brief",
    description:
      "Submit the technical brief: exactly one task per declared function and page, with goal, details, uses and AC refs.",
    input: z.object({ tasks: z.array(briefTaskSchema).min(1).max(MAX_BRIEF_TASKS) }),
    check: ({ tasks }) => briefIssues(tasks, scope),
  });
}

/** Shared modules a task may own (not declared in the spec): functions/lib/** and ui/components/**. */
export const LIB_FILE_RE = /^(functions\/lib\/[A-Za-z0-9_/-]+\.ts|ui\/components\/[A-Za-z0-9_/-]+\.tsx)$/;

export const KIND_ORDER = ["lib", "function", "page"] as const;

/** Shared modules, then functions, then pages (builder.yaml#harness.stages.tasks.parallel), stable within a kind. */
export function taskOrder(tasks: readonly BriefTask[]): BriefTask[] {
  return KIND_ORDER.flatMap((k) => tasks.filter((t) => t.kind === k));
}

export const BRIEF_TEXT = (title: string, mode: "create" | "change") =>
  [
    `Ты архитектор. Спека системы «${title}» готова. Составь техническое задание вызовом submit_brief.`,
    mode === "create"
      ? "Ровно одна задача на каждую объявленную функцию и страницу спеки (file — как в спеке)."
      : "Задачи — на новые функции и страницы и на те, что меняются по карточке изменений (file — как в спеке).",
    "goal — что делает файл и для кого. details — конкретика для исполнителя, который не видит интервью: для страницы —",
    "блоки ui-kit по порядку с их текстами по брифу и карточке, поля форм, что видно в пустом состоянии и при ошибке;",
    "для функции — аргументы и их типы, что возвращает, кто вызывает, что проверяет и что меняет.",
    "Общий код нескольких файлов (расчёт, форматирование, общий компонент) — отдельная задача kind=lib с файлом",
    "functions/lib/<имя>.ts или ui/components/<Имя>.tsx; такие файлы в спеке не объявляются.",
    "uses — функции, которые вызывает страница (имена из спеки), или сущности и функции, с которыми работает функция;",
    "общие модули, которыми пользуется задача, — их путями.",
    "acRefs — критерии карточки, которые задача выполняет; каждый критерий, кроме прав, — хотя бы в одной задаче.",
  ].join(" ");

/** Scenario checks that call the function (qa.yaml#checks, test-first): attached to its task as text. */
export function checksForFunction(checks: readonly QaCheck[], fnName: string): QaCheck[] {
  return checks.filter((c) => c.scenario?.steps.some((s) => s.callFn?.name === fnName));
}

function checkText(c: QaCheck): string {
  const sc = c.scenario;
  if (!sc) return `- ${c.id}`;
  const steps = sc.steps
    .map((s) => {
      const who = typeof s.as === "string" ? s.as : s.as?.role;
      const act = s.callFn
        ? `callFn ${s.callFn.name}(${JSON.stringify(s.callFn.args ?? {})})`
        : s.create
          ? `create ${s.create.entity}`
          : s.read
            ? `read ${s.read.entity}`
            : s.update
              ? `update ${s.update.entity}`
              : s.delete
                ? `delete ${s.delete.entity}`
                : Object.keys(s)
                    .filter((k) => k !== "as" && k !== "expect")
                    .join(",");
      const exp = s.expect ? ` → ${JSON.stringify(s.expect)}` : "";
      return `${who ? `${who}: ` : ""}${act}${exp}`;
    })
    .join("; ");
  return `- ${c.id}${c.acId ? ` (${c.acId})` : ""} «${sc.title}»: ${steps}`.slice(0, 900);
}

export interface TaskMessageInput {
  card: BuildCard;
  spec: AppSpec;
  task: BriefTask;
  checks: readonly QaCheck[];
  current: string | null;
  /** Shared modules of the brief this task uses: goal and current text (null — not written yet). */
  libs?: readonly { task: BriefTask; content: string | null }[];
  /** Fix round: the findings of this file and QA explanations. */
  fix?: { findings: readonly Check[]; explanations?: readonly unknown[] };
}

export function taskMessage(a: TaskMessageInput): string {
  const t = a.task;
  const acs = a.card.acceptance.filter((ac) => t.acRefs.includes(ac.id));
  const fns = (a.spec.functions ?? []).filter((f) => t.uses.includes(f.name));
  const lines = [
    cardDigest(a.card),
    "",
    "Спека системы:",
    specDigest(a.spec),
    "",
    `Твоя задача ${t.id} — ${t.kind === "page" ? "страница" : t.kind === "function" ? "функция" : "общий модуль"} ${t.file}: ${t.title}.`,
    `Цель: ${t.goal}`,
  ];
  if (t.details.length) lines.push("Детали:", ...t.details.map((d) => `- ${d}`));
  if (fns.length)
    lines.push(
      "Вызывает функции:",
      ...fns.map((f) => `- ${f.name} (${f.kind}, ${f.file})${f.public ? ", публичная" : ""}`),
    );
  for (const lib of a.libs ?? [])
    lines.push(
      `Общий модуль ${lib.task.file} (${lib.task.title}): ${lib.task.goal}`,
      ...(lib.content === null
        ? ["(ещё пишется — опирайся на его цель)"]
        : ["```", lib.content.slice(0, 6000), "```"]),
    );
  if (acs.length) lines.push("Критерии приёмки:", ...acs.map((ac) => `- ${ac.id}: ${ac.text}`));
  if (a.checks.length)
    lines.push("Должно пройти (проверки QA в G1):", ...a.checks.slice(0, 8).map(checkText));
  if (a.current === null) lines.push("", "Файла ещё нет.");
  else if (a.current.slice(0, 200).includes(STUB_MARKER))
    lines.push("", `Сейчас в файле заготовка (${STUB_MARKER}) — перепиши его целиком.`);
  else lines.push("", "Текущий текст файла:", "```", a.current, "```");
  if (a.fix) {
    lines.push("", "Проверки нашли ошибки в этом файле:", ...findingLines(a.fix.findings));
    if (a.fix.explanations?.length)
      lines.push("Объяснения QA:", ...a.fix.explanations.slice(0, 6).map((e) => `- ${JSON.stringify(e)}`));
  }
  lines.push(
    "",
    `Запиши ровно один файл — ${t.file} — полным текстом через write_file; другие файлы не трогай, вспомогательные компоненты объявляй в этом же файле.`,
    "После записи харнесс сам проверит файл и вернёт ошибки, если они есть. Когда файл готов, ответь одной строкой без вызова инструментов.",
  );
  return lines.join("\n");
}

export function findingLines(findings: readonly Check[]): string[] {
  const lines = findings
    .slice(0, 20)
    .map(
      (c) =>
        `- ${c.id}${c.line ? ` строка ${c.line}` : ""}: ${c.message_ru}${c.fixHint ? ` (подсказка: ${c.fixHint})` : ""}`,
    );
  if (findings.some((c) => c.id === "G0-TS-01" || c.id === "G0-FN-01")) lines.push(SDK_FIX_HINT);
  return lines;
}

export const FINDINGS_TEXT = (file: string, findings: readonly Check[]) =>
  [`Проверка файла ${file} нашла ошибки:`, ...findingLines(findings), "Исправь и запиши файл целиком."].join(
    "\n",
  );

export const WRITE_NUDGE = (file: string) =>
  `Файл ${file} не записан. Запиши его полным текстом через write_file — это и есть задача.`;

// ---------------------------------------------------------------- reviewer

export const reviewSchema = z.object({
  verdict: z.enum(["ok", "fix"]),
  issues: z
    .array(z.object({ severity: z.enum(["critical", "minor"]), text: z.string().trim().min(1).max(300) }))
    .max(8),
});
export type Review = z.infer<typeof reviewSchema>;

export const submitReviewTool = () =>
  defineTool({
    name: "submit_review",
    description: "Submit the review of one page against its brief: verdict and issues (critical or minor).",
    input: reviewSchema,
    check: (r) =>
      r.verdict === "fix" && !r.issues.some((i) => i.severity === "critical")
        ? [{ path: "verdict", code: "REVIEW_VERDICT", message: "verdict=fix только при критичной проблеме." }]
        : [],
  });

export const REVIEW_SYSTEM = [
  "Ты рецензент страниц системы, собранной другим агентом. Сверь страницу с задачей технического задания и карточкой.",
  "critical — только то, что лишает владельца ценности: страница пустая или заглушка («Страница готовится», lorem, TODO);",
  "нет формы, кнопки или списка, которых требует задача или критерий приёмки; тексты не по брифу, не на русском или",
  "видны служебные строки (id, null, undefined, названия полей латиницей); страница не вызывает нужную функцию из задачи.",
  "Остальное (порядок блоков, формулировки, стиль) — minor. Ничего не выдумывай сверх задачи. Ответь вызовом submit_review.",
].join(" ");

export function reviewMessage(a: { card: BuildCard; task: BriefTask; source: string }): string {
  const t = a.task;
  const acs = a.card.acceptance.filter((ac) => t.acRefs.includes(ac.id));
  return [
    a.card.title ? `Система: «${a.card.title}»${a.card.summary ? ` — ${a.card.summary}` : ""}` : "",
    `Задача ${t.id} — страница ${t.file}: ${t.title}.`,
    `Цель: ${t.goal}`,
    ...(t.details.length ? ["Детали:", ...t.details.map((d) => `- ${d}`)] : []),
    ...(t.uses.length ? [`Вызывает функции: ${t.uses.join(", ")}`] : []),
    ...(acs.length ? ["Критерии приёмки:", ...acs.map((ac) => `- ${ac.id}: ${ac.text}`)] : []),
    "",
    "Текст страницы:",
    "```tsx",
    a.source.slice(0, 40_000),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function reviewFindings(r: Review): Check[] {
  return r.issues
    .filter((i) => i.severity === "critical")
    .map((i) => ({
      id: "REVIEW",
      status: "fail" as const,
      severity: "blocker" as const,
      message_ru: `Рецензент: ${i.text}`,
    })) as Check[];
}

// ---------------------------------------------------------------- waves

export type BatchDispatch = (
  inputs: RouteInput[],
) => Promise<({ ok: true; out: RouteOutput } | { ok: false; error: Error })[]>;

/**
 * Lockstep waves (builder.yaml#harness.tasks.parallel): every job gets its own route(); a batch goes out when each live
 * job either waits for an answer or has finished, in job order — so the sequence of host calls does not depend on
 * timing. Returns the jobs' settled results in job order.
 */
export async function runWave<T>(
  jobs: readonly ((route: (input: RouteInput) => Promise<RouteOutput>) => Promise<T>)[],
  dispatch: BatchDispatch,
): Promise<PromiseSettledResult<T>[]> {
  type Waiter = {
    idx: number;
    input: RouteInput;
    resolve: (o: RouteOutput) => void;
    reject: (e: Error) => void;
  };
  let live = jobs.length;
  let waiting: Waiter[] = [];
  let flushing = false;
  const maybeFlush = () => {
    if (flushing || waiting.length === 0 || waiting.length < live) return;
    flushing = true;
    const batch = [...waiting].sort((a, b) => a.idx - b.idx);
    waiting = [];
    dispatch(batch.map((w) => w.input))
      .then((res) => {
        batch.forEach((w, i) => {
          const r = res[i];
          if (r?.ok) w.resolve(r.out);
          else w.reject(r?.error ?? new Error("batch answer missing"));
        });
      })
      .catch((e: unknown) => {
        for (const w of batch) w.reject(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        flushing = false;
        maybeFlush();
      });
  };
  return Promise.allSettled(
    jobs.map((job, idx) =>
      job(
        (input) =>
          new Promise<RouteOutput>((resolve, reject) => {
            waiting.push({ idx, input, resolve, reject });
            maybeFlush();
          }),
      ).finally(() => {
        live -= 1;
        maybeFlush();
      }),
    ),
  );
}

// ---------------------------------------------------------------- metrics

export interface BuildMetrics {
  ops: { calls: number };
  brief: { tasks: number; retries: number; fallback: boolean };
  checks: { total: number; attached: number };
  tasks: { total: number; firstPass: number; passed: number; failed: number; calls: number };
  verify: { g0Runs: number; g1Runs: number; fixTasks: number; fixPhases: number };
  review: { pages: number; ok: number; critical: number; minor: number; skipped: boolean };
}

export const emptyMetrics = (): BuildMetrics => ({
  ops: { calls: 0 },
  brief: { tasks: 0, retries: 0, fallback: false },
  checks: { total: 0, attached: 0 },
  tasks: { total: 0, firstPass: 0, passed: 0, failed: 0, calls: 0 },
  verify: { g0Runs: 0, g1Runs: 0, fixTasks: 0, fixPhases: 0 },
  review: { pages: 0, ok: 0, critical: 0, minor: 0, skipped: false },
});
