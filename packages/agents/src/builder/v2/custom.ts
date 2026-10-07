// Stage «Дописывание» of the builder v2 (B2-23, builder.yaml#v2.stages.custom, callType build_custom): the model writes
// the code of the plan's custom items (≤ 2 screens, ≤ 3 functions — modules.yaml#system_plan.custom_limits) on top of the
// compiled system, into the reserved files of compilePlan().customSlots (ui/custom/**, functions/custom/**). It never
// touches entities, roles, permissions or module files. The draft is checked by G0–G2; blockers in the custom files
// go back to the model for ≤ 2 rounds of fixes, within the stage budget (≤ 20 ₽). A failure is isolated: the parts that
// still fail (or all of them, when a blocker cannot be pinned to a part) are rolled back — the system comes out without
// them, the client reads the replacement in plain words, and each such part goes to «Запросы на развитие».
import {
  type AppFunction,
  type AppSpec,
  CUSTOM_LIMITS,
  identSchema,
  type Page,
  type SystemPlan,
  validateSpec,
} from "@wizard/appspec";
import type { Check, GoalScenarioInput } from "@wizard/gates";
import { LlmError, type LlmMessage } from "@wizard/llm";
import type { CustomSlot, ModuleRegistry } from "@wizard/modules";
import { scrub } from "@wizard/pii";
import { z } from "zod";
import type { RunStepFn } from "../../core/events.js";
import { type CallStats, callTool, type RouteFn, type StructuredResult } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { textRulesSection } from "../../text-rules.js";
import { specDigest } from "../digest.js";
import { PROMPT_PARTS, uiKitDocs } from "../docs.js";
import { evidenceOf, SDK_FIX_HINT } from "../prompt.js";
import { buildBlockers } from "./blockers.js";
import type { CustomStageFn, V2Host } from "./types.js";
import { StageBudgetError } from "./wallet.js";

/** Max source size of one custom file (a screen or a function of a small part). */
export const CUSTOM_CODE_MAX = 30_000;

/** One part of submit_custom: the code of a slot, who may use it, and the function kind. */
const customItemSchema = z.strictObject({
  id: identSchema,
  /** Role names of the spec that may open the screen / call the function. */
  roles: z.array(identSchema).min(1).max(8),
  /** Functions only: query (read), mutation (read and write), action (connectors, no ctx.db). */
  kind: z.enum(["query", "mutation", "action"]).optional(),
  /** Screens only: show in the navigation. */
  nav: z.boolean().optional(),
  code: z.string().min(20).max(CUSTOM_CODE_MAX),
});

/** submit_custom input: the code of the parts asked in this round. */
export const customInputSchema = z.strictObject({
  items: z
    .array(customItemSchema)
    .min(1)
    .max(CUSTOM_LIMITS.screens + CUSTOM_LIMITS.functions),
});
export type CustomInput = z.output<typeof customInputSchema>;
export type CustomItem = CustomInput["items"][number];

/** The slots built by the stage and the ones over the limit (they go straight to «Запросы на развитие»). */
export function selectCustomSlots(slots: readonly CustomSlot[]): { build: CustomSlot[]; over: CustomSlot[] } {
  const build: CustomSlot[] = [];
  const over: CustomSlot[] = [];
  let screens = 0;
  let functions = 0;
  for (const s of slots) {
    const fits = s.kind === "screen" ? screens < CUSTOM_LIMITS.screens : functions < CUSTOM_LIMITS.functions;
    if (!fits) {
      over.push(s);
      continue;
    }
    if (s.kind === "screen") screens += 1;
    else functions += 1;
    build.push(s);
  }
  return { build, over };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The spec and files of the compiled system with the given custom parts on top. */
export function mergeCustom(
  base: { spec: AppSpec; files: Readonly<Record<string, string>> },
  parts: readonly { slot: CustomSlot; item: CustomItem }[],
): { spec: AppSpec; files: Record<string, string> } {
  const publicRoles = new Set(base.spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  const pages: Page[] = [...(base.spec.pages ?? [])];
  const functions: AppFunction[] = [...(base.spec.functions ?? [])];
  const files: Record<string, string> = { ...base.files };
  for (const { slot, item } of parts) {
    files[slot.file] = item.code;
    if (slot.kind === "screen")
      pages.push({
        route: slot.route ?? `/custom-${slot.id.replace(/_/g, "-")}`,
        title: cut(slot.title, 80),
        file: slot.file,
        roles: [...item.roles],
        ...(item.nav ? { nav: true } : {}),
      });
    else
      functions.push({
        name: slot.name,
        kind: item.kind ?? "query",
        file: slot.file,
        roles: [...item.roles],
        ...(item.roles.some((r) => publicRoles.has(r)) ? { public: true } : {}),
      });
  }
  const spec = { ...base.spec } as AppSpec;
  if (pages.length) spec.pages = pages;
  if (functions.length) spec.functions = functions;
  return { spec, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
}

/** Problems of submit_custom: unknown or missing parts, the wrong shape of code, unknown roles, an invalid spec. */
export function customIssues(
  base: { spec: AppSpec; files: Readonly<Record<string, string>> },
  asked: readonly CustomSlot[],
  input: CustomInput,
): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const byId = new Map(asked.map((s) => [s.id, s]));
  const roles = new Set(base.spec.roles.map((r) => r.name));
  const seen = new Set<string>();
  for (const [i, item] of input.items.entries()) {
    const path = `items.${i}`;
    const slot = byId.get(item.id);
    if (!slot) {
      issues.push({
        path: `${path}.id`,
        code: "UNKNOWN_PART",
        message: `Части «${item.id}» нет в задаче. Пришли только: ${[...byId.keys()].join(", ")}.`,
      });
      continue;
    }
    if (seen.has(item.id))
      issues.push({ path, code: "DUPLICATE", message: `Часть «${item.id}» прислана дважды.` });
    seen.add(item.id);
    for (const r of item.roles)
      if (!roles.has(r))
        issues.push({
          path: `${path}.roles`,
          code: "UNKNOWN_ROLE",
          message: `Роли «${r}» в системе нет. Роли: ${[...roles].join(", ")}.`,
        });
    if (!/export\s+default\b/.test(item.code))
      issues.push({
        path: `${path}.code`,
        code: "NO_DEFAULT_EXPORT",
        message: "Нужен ровно один export default.",
      });
    if (slot.kind === "function") {
      if (!item.kind)
        issues.push({
          path: `${path}.kind`,
          code: "KIND_REQUIRED",
          message: "У функции укажи kind: query, mutation или action.",
        });
      else if (!new RegExp(`export\\s+default\\s+${item.kind}\\s*\\(`).test(item.code))
        issues.push({
          path: `${path}.code`,
          code: "KIND_MISMATCH",
          message: `Код функции — export default ${item.kind}({ args, handler }) из @wizard/sdk.`,
        });
    } else {
      if (item.kind)
        issues.push({
          path: `${path}.kind`,
          code: "SCREEN_KIND",
          message: "У экрана нет kind — убери поле.",
        });
      if (/\b(query|mutation|action)\s*\(\s*\{/.test(item.code))
        issues.push({
          path: `${path}.code`,
          code: "FUNCTION_IN_SCREEN",
          message:
            "Экран не объявляет query/mutation/action — вызывай функции по имени через useQuery/useMutation.",
        });
    }
  }
  for (const s of asked)
    if (!seen.has(s.id))
      issues.push({
        path: "items",
        code: "MISSING_PART",
        message: `Не хватает части «${s.id}» (${s.title}).`,
      });
  if (issues.length) return issues;
  const merged = mergeCustom(
    base,
    input.items.map((item) => ({ slot: byId.get(item.id) as CustomSlot, item })),
  );
  const r = validateSpec(merged.spec);
  if (!r.ok)
    for (const e of r.errors.slice(0, 10)) issues.push({ path: e.path, code: e.code, message: e.message_ru });
  return issues;
}

const ROLE =
  "Ты — разработчик Born to Build. Система клиента уже собрана из готовых модулей; ты дописываешь в неё только небольшие недостающие части из списка задачи: экраны (React на @wizard/ui-kit) и серверные функции (@wizard/sdk).";

const RULES = [
  "Пиши только части из списка задачи: для каждой уже заданы файл, имя и адрес. Другие файлы, сущности, поля, роли и права не меняются — работай с тем, что есть в спеке.",
  "Экран — `export default function <Имя>()` из списка, страница обёрнута в AppShell с title части; данные — хуки @wizard/sdk (useQuery/useMutation по имени функции, useEntityList, useEntityMutation), компоненты — из @wizard/ui-kit.",
  "Функция — ровно один `export default query|mutation|action({ args, handler })` по шпаргалке @wizard/sdk; kind в ответе совпадает с кодом. Экраны вызывают её по имени из списка задачи.",
  "roles — кто открывает экран или вызывает функцию: имена ролей из спеки. Экран для посетителей сайта — роль с доступом public; данные с контактами людей посетителям не показывай.",
  "Тексты интерфейса — на русском, по правилам ниже. В коде нет персональных данных (имён, телефонов, почт и адресов людей) и выдуманных цен и цифр.",
  "Отвечай только вызовом submit_custom. Если инструмент или проверки вернули ошибки — исправь именно их и пришли части снова.",
];

function slotLine(s: CustomSlot, description: string): string {
  const where =
    s.kind === "screen"
      ? `файл ${s.file}, компонент ${s.name.replace(/(^|_)([a-z])/g, (_m, _p, c: string) => c.toUpperCase())}, адрес ${s.route}`
      : `файл ${s.file}, имя функции ${s.name}`;
  return `- ${s.id} — ${s.kind === "screen" ? "экран" : "функция"} «${s.title}»: ${description} (${where})`;
}

/** Prompt of the stage: static rules and references (cacheable prefix) + the business, the spec and the parts. */
export function customMessages(plan: SystemPlan, spec: AppSpec, slots: readonly CustomSlot[]): LlmMessage[] {
  const desc = new Map(plan.custom.map((c) => [c.id, c.description]));
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Правила",
        RULES.map((r) => `- ${r}`).join("\n"),
        "## Соглашения кода",
        PROMPT_PARTS.conventions,
        "## @wizard/sdk: шпаргалка (точный API; другого нет)",
        PROMPT_PARTS.sdk,
        uiKitDocs().docs,
        "## Тексты для людей",
        textRulesSection("system"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: scrub(
        [
          `## Бизнес\nНиша: ${plan.niche}\nЦели: ${plan.goals.map((g) => g.statement).join("; ")}`,
          `## Спека системы\n${specDigest(spec)}`,
          `## Части, которые нужно дописать\n${slots.map((s) => slotLine(s, desc.get(s.id) ?? s.title)).join("\n")}`,
          "## Задача\nНапиши код каждой части и вызови submit_custom.",
        ].join("\n\n"),
      ).text,
    },
  ];
}

/** The custom parts a blocker points at: by file, by spec path of a custom page/function, or by route/name in the text. */
export function implicated(check: Check, parts: readonly CustomSlot[], spec: AppSpec): CustomSlot[] {
  const text = `${check.message_ru} ${check.evidence ?? ""} ${check.path ?? ""}`;
  const ptr = check.path?.match(/^\/?(pages|functions)\/(\d+)/);
  const byPtr = ptr?.[2]
    ? (ptr[1] === "pages" ? spec.pages : spec.functions)?.[Number(ptr[2])]?.file
    : undefined;
  return parts.filter(
    (s) =>
      check.file === s.file ||
      byPtr === s.file ||
      text.includes(s.file) ||
      (s.route !== undefined && new RegExp(`${s.route}(?![\\w-])`).test(text)) ||
      new RegExp(`\\b${s.name}\\b`).test(text),
  );
}

/** Fix-round message: the blockers of the custom parts and which parts to send again. */
export function customFixText(
  level: string,
  blockers: readonly Check[],
  parts: readonly CustomSlot[],
): string {
  const lines = [
    `Проверки ${level} нашли ошибки в дописанных частях:`,
    ...blockers
      .slice(0, 20)
      .map(
        (c) =>
          `- ${c.id}${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ""}` : ""}${c.path ? ` ${c.path}` : ""}: ${c.message_ru}${evidenceOf(c)}${c.fixHint ? ` (подсказка: ${c.fixHint})` : ""}`,
      ),
  ];
  if (blockers.some((c) => c.id === "G0-TS-01" || c.id === "G0-FN-01")) lines.push(SDK_FIX_HINT);
  lines.push(
    `Исправь и пришли через submit_custom заново только части: ${parts.map((p) => p.id).join(", ")}.`,
  );
  return lines.join("\n");
}

/** What the client reads instead of a part that did not make it, in plain words. */
export function customReplacementRu(
  item: { title: string; module?: string | undefined },
  registry: ModuleRegistry,
): string {
  const mod = item.module ? registry.modules.find((m) => m.manifest.id === item.module) : undefined;
  return mod
    ? `Пока пользуйтесь разделом «${mod.manifest.name}» — он закрывает основную задачу; «${item.title}» команда посмотрит отдельно.`
    : `Пока система работает без «${item.title}»; команда посмотрит запрос и предложит решение.`;
}

export type CustomFailReason = "limit" | "budget" | "invalid" | "gates" | "not_isolated";

export interface CustomPartResult {
  id: string;
  kind: "screen" | "function";
  title: string;
  status: "done" | "failed";
  reason?: CustomFailReason;
}

export interface CustomStageResult {
  /** The draft revision after the stage (the compiled one when nothing was added). */
  revision: number;
  items: CustomPartResult[];
  /** Gate rounds after the first answer (≤ CUSTOM_LIMITS.rounds). */
  rounds: number;
  notes_ru: string[];
  /** Parts that did not make it, as outOfScope entries of the plan (the approved revision itself is not changed). */
  outOfScope: { request: string; replacement: string; category: "custom_logic"; module?: string }[];
  stats: CallStats;
}

const NOTE_RU: Record<CustomFailReason, string> = {
  limit: "не уместилось в лимит дописывания (2 экрана и 3 функции)",
  budget: "не уложилось в бюджет дописывания",
  invalid: "не получилось написать без ошибок",
  gates: "не прошло автоматическую проверку",
  not_isolated: "не прошло автоматическую проверку",
};

/**
 * Errors of a call the stage isolates: the stage budget (StageBudgetError) and the host cap (BUDGET_EXCEEDED). Models
 * being unavailable, a cancellation or a fixture miss fail the run (retryable; «Исправить» resumes at this stage).
 */
function isolatable(e: unknown): CustomFailReason | null {
  if (e instanceof StageBudgetError) return "budget";
  if (e instanceof LlmError) return e.code === "BUDGET_EXCEEDED" ? "budget" : null;
  return null;
}

/** Runs the custom-code stage over the compiled draft revision `revision` (B2-23). */
export async function runCustomStage(o: {
  host: V2Host;
  route: RouteFn;
  runStep: RunStepFn;
  signal?: AbortSignal;
  plan: SystemPlan;
  registry: ModuleRegistry;
  /** The compiled draft: its spec (owner fields kept), module files and reserved custom slots. */
  base: { spec: AppSpec; files: Readonly<Record<string, string>>; revision: number };
  slots: readonly CustomSlot[];
  /** G1 overrides the gates stage uses (goal scenarios with a browser). */
  goalScenarios?: readonly GoalScenarioInput[];
  maxRounds?: number;
}): Promise<CustomStageResult> {
  const maxRounds = o.maxRounds ?? CUSTOM_LIMITS.rounds;
  const { build, over } = selectCustomSlots(o.slots);
  const failed = new Map<string, CustomFailReason>(over.map((s) => [s.id, "limit"]));
  const code = new Map<string, CustomItem>();
  const stats: CallStats = { calls: 0, creditsCharged: 0, ruFallback: false };
  let revision = o.base.revision;
  let committedCustom = false;
  let rounds = 0;
  let pending: CustomSlot[] = [...build];
  let messages = customMessages(o.plan, o.base.spec, build);
  let lastBlockers: Check[] = [];
  let lastChecked: CustomSlot[] = [];
  let passed = false;

  const parts = (slots: readonly CustomSlot[]) =>
    slots.flatMap((slot) => {
      const item = code.get(slot.id);
      return item ? [{ slot, item }] : [];
    });

  /**
   * Commits the compiled system with these parts and runs G0 → G1 → G2 up to the first level with blockers (G2 without
   * the owner-input checks, as the gates stage): a custom part never reaches the gates stage with a blocker of its own.
   */
  const check = async (slots: readonly CustomSlot[]): Promise<{ level: string; blockers: Check[] }> => {
    const merged = mergeCustom(o.base, parts(slots));
    const titles = slots.map((s) => `«${s.title}»`).join(", ");
    revision = (
      await o.host.commitCompiled({
        spec: merged.spec,
        files: merged.files,
        summary_ru: `Дописано поверх модулей: ${titles}`,
      })
    ).revision;
    committedCustom = true;
    for (const level of ["G0", "G1", "G2"] as const) {
      const r = await o.host.runGates(
        level,
        level === "G1" && o.goalScenarios ? { goalScenarios: o.goalScenarios } : undefined,
      );
      const blockers = r.passed ? [] : buildBlockers(r);
      if (blockers.length) return { level, blockers };
    }
    return { level: "G2", blockers: [] };
  };

  if (build.length) {
    for (let attempt = 0; attempt <= maxRounds; attempt++) {
      const tool = defineTool({
        name: "submit_custom",
        description:
          "The code of the custom parts asked: one item per part (id, roles, kind for a function, code).",
        input: customInputSchema,
        check: (v) => customIssues(o.base, pending, v),
      });
      let r: StructuredResult<CustomInput>;
      try {
        r = await callTool({
          route: o.route,
          callType: "build_custom",
          orgPolicy: null,
          ctx: { orgId: "host" },
          runStep: o.runStep,
          ...(o.signal ? { signal: o.signal } : {}),
          stepName: attempt === 0 ? "custom" : `custom_fix_${attempt}`,
          messages,
          tool,
          maxRepairs: 1,
        });
      } catch (e) {
        const reason = isolatable(e);
        if (!reason) throw e;
        for (const s of pending) failed.set(s.id, reason);
        break;
      }
      stats.calls += r.stats.calls;
      stats.creditsCharged = Math.round((stats.creditsCharged + r.stats.creditsCharged) * 1000) / 1000;
      stats.ruFallback ||= r.stats.ruFallback;
      rounds = attempt;
      if (!r.ok) {
        for (const s of pending) failed.set(s.id, "invalid");
        break;
      }
      for (const item of r.value.items) code.set(item.id, item);
      const alive = build.filter((s) => !failed.has(s.id));
      const res = await check(alive);
      lastBlockers = res.blockers;
      lastChecked = alive;
      if (!res.blockers.length) {
        passed = true;
        break;
      }
      const spec = mergeCustom(o.base, parts(alive)).spec;
      const hit = alive.filter((s) => res.blockers.some((c) => implicated(c, [s], spec).length));
      // A blocker no custom part can be blamed for: no fix by the model (it may be a module bug — the gates stage judges).
      const blamed = res.blockers.filter((c) => implicated(c, alive, spec).length);
      if (!hit.length || blamed.length < res.blockers.length || attempt === maxRounds) break;
      pending = hit;
      messages = [...r.messages, { role: "user", content: customFixText(res.level, blamed, hit) }];
    }
  }

  // Isolation: the parts the last blockers point at are dropped; the rest stays only when every blocker was explained
  // by a dropped part and the draft without them passes G0–G2. Otherwise the whole custom part is rolled back.
  let kept = build.filter((s) => !failed.has(s.id) && code.has(s.id));
  if (!passed && kept.length) {
    const spec = mergeCustom(o.base, parts(lastChecked)).spec;
    for (const s of kept)
      if (lastBlockers.some((c) => implicated(c, [s], spec).length)) failed.set(s.id, "gates");
    kept = kept.filter((s) => !failed.has(s.id));
    const explained = lastBlockers.every((c) =>
      implicated(c, lastChecked, spec).some((s) => failed.has(s.id)),
    );
    if (kept.length && explained) {
      const res = await check(kept);
      if (res.blockers.length) for (const s of kept) failed.set(s.id, "not_isolated");
      else passed = true;
    } else for (const s of kept) failed.set(s.id, "not_isolated");
    kept = kept.filter((s) => !failed.has(s.id));
  }
  if (!kept.length && committedCustom) {
    // Rollback: the compiled system without any custom part, as a new draft revision.
    revision = (
      await o.host.commitCompiled({
        spec: o.base.spec,
        files: o.base.files,
        summary_ru: "Система собрана по плану без дописанных частей",
      })
    ).revision;
  }

  const items: CustomPartResult[] = o.slots.map((s) => {
    const reason = failed.get(s.id);
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      status: reason ? "failed" : "done",
      ...(reason ? { reason } : {}),
    };
  });
  const notes: string[] = [];
  const outOfScope: CustomStageResult["outOfScope"] = [];
  const done = items.filter((i) => i.status === "done");
  if (done.length) notes.push(`Дописано под вашу задачу: ${done.map((i) => `«${i.title}»`).join(", ")}.`);
  for (const it of items) {
    if (it.status !== "failed" || !it.reason) continue;
    const c = o.plan.custom.find((x) => x.id === it.id);
    const replacement = customReplacementRu({ title: it.title, module: c?.module }, o.registry);
    await o.host.recordDevelopmentRequest?.({
      category: "other",
      quote: `${it.title}: ${c?.description ?? it.title}`,
      offered: replacement,
    });
    outOfScope.push({
      request: cut(`${it.title}: ${c?.description ?? it.title}`, 300),
      replacement: cut(replacement, 300),
      category: "custom_logic",
      ...(c?.module ? { module: c.module } : {}),
    });
    notes.push(
      `«${it.title}» ${NOTE_RU[it.reason]} — система собрана без этой части. ${replacement} Мы записали это в запросы на развитие.`,
    );
  }
  return { revision, items, rounds, notes_ru: notes, outOfScope, stats };
}

/** The default custom stage of runBuildV2 (V2Params.custom): runCustomStage over the stage wallet's route. */
export const buildCustom: CustomStageFn = async (ctx) => {
  const r = await runCustomStage({
    host: ctx.host,
    route: ctx.route,
    runStep: ctx.host.runStep,
    ...(ctx.host.signal ? { signal: ctx.host.signal } : {}),
    plan: ctx.plan,
    registry: ctx.registry,
    base: ctx.base,
    slots: ctx.slots,
    ...(ctx.goalScenarios ? { goalScenarios: ctx.goalScenarios } : {}),
  });
  const done = r.items.filter((i) => i.status === "done").length;
  return {
    data: { items: r.items, rounds: r.rounds, outOfScope: r.outOfScope },
    costMilli: 0,
    notes_ru: r.notes_ru,
    revision: r.revision,
    ...(done < r.items.length ? { fallback: true } : {}),
    note: `дописано ${done} из ${r.items.length}, раундов исправления ${r.rounds}`,
  };
};
