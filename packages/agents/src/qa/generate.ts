// Check generation (agents/qa.yaml#checks): PC matrix without LLM, permission AC → SC 1:1, scenario/constraint AC →
// qa_generate (submit_checks) with static validation, one repeat and a cache by (specVersion, AC id, sha256(text)).
import { createHash } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import {
  compareMilestones,
  generateConsentChecks,
  generatePermissionChecks,
  type QaCheck,
  type Scenario,
  selectG1,
  validateScenario,
} from "@wizard/gates";
import type { LlmMessage, RouteInput, RouteOutput } from "@wizard/llm";
import type { BuildCard } from "../builder/types.js";
import { identityStep, type Tool, toolError, zodIssues } from "../core/index.js";
import { GENERATE_SYSTEM, qaDigest } from "./prompt.js";
import { scenarioSchema, submitChecksTool } from "./schemas.js";
import type { CachedAc, QaAgentOptions } from "./types.js";

export type CardAc = BuildCard["acceptance"][number];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** qa.yaml#checks.determinism */
export const cacheKey = (specVersion: number, ac: Pick<CardAc, "id" | "text">) =>
  `${specVersion}:${ac.id}:${sha256(ac.text)}`;

export const isLater = (m: string | undefined, ctx: string) => compareMilestones(m ?? "M0", ctx) > 0;

export const resolveMilestone = (m?: string) => m ?? process.env.WIZARD_MILESTONE ?? "M0";

/** Full PC matrix + consent probes; the G1 selection (qa.yaml#…permission_auto.selection) is level G1, the rest G2. */
export function permissionChecks(spec: AppSpec, acs: readonly CardAc[]): QaCheck[] {
  const all = [...generatePermissionChecks(spec), ...generateConsentChecks(spec)];
  const withAcs = { ...spec, acceptance: acs.map((a) => ({ id: a.id, text: a.text, check: a.check })) };
  const g1 = new Set(selectG1(withAcs, all).map((c) => c.id));
  return all.map((c) => ({ ...c, level: g1.has(c.id) ? "G1" : "G2" }));
}

/** AC type=permission → SC-<AC id> probe 1:1 (qa.yaml#checks.from_acceptance.permission). */
export function acPermissionCheck(ac: CardAc): QaCheck | null {
  const c = ac.check;
  if (c.type !== "permission" || !c.role || !c.entity || !c.op || !c.expect) return null;
  return {
    id: `SC-${ac.id}`,
    acId: ac.id,
    kind: "permission",
    level: "G1",
    role: c.role,
    entity: c.entity,
    probe: { kind: "op", op: c.op, expect: c.expect },
    milestone: c.milestone ?? "M0",
  };
}

const NEGATIVE_STATUS = new Set(["denied", "not_found", "invalid", "conflict", "limit"]);

const piiCategory = (f: { pii?: string | undefined; type: string }) =>
  f.pii ?? (f.type === "file" ? "basic" : "none");
const norm = (s: string) => s.toLowerCase().replace(/_/g, "");

/**
 * gates validateScenario + the QA rules: acId and id match the AC, ≥1 expect, constraint has a negative branch,
 * create/callFn writing pii≠none fields from a non-admin role carries consent: true.
 */
export function qaValidateScenario(spec: AppSpec, sc: Scenario, ac: CardAc): string[] {
  const errs = validateScenario(spec, sc);
  if (sc.acId !== ac.id) errs.push(`acId ${sc.acId} не совпадает с критерием ${ac.id}`);
  if (sc.id !== `SC-${ac.id}` && !sc.id.startsWith(`SC-${ac.id}-`))
    errs.push(`id ${sc.id} должен быть SC-${ac.id} или SC-${ac.id}-<n>`);
  const expects = sc.steps.filter((s) => s.expect);
  if (expects.length === 0) errs.push("В сценарии нет ни одного expect");
  if (
    ac.check.type === "constraint" &&
    !expects.some((s) => {
      const e = s.expect ?? {};
      return (
        e.error !== undefined ||
        (typeof e.status === "number"
          ? e.status >= 400
          : e.status !== undefined && NEGATIVE_STATUS.has(e.status))
      );
    })
  )
    errs.push("constraint: нужна негативная ветка — действие, нарушающее ограничение, с ожиданием ошибки");
  const roles = new Map(spec.roles.map((r) => [r.name, r]));
  const piiFields = new Map(
    spec.entities.map((e) => [
      e.name,
      new Set(e.fields.filter((f) => piiCategory(f) !== "none").map((f) => f.name)),
    ]),
  );
  const allPii = new Set([...piiFields.values()].flatMap((s) => [...s].map(norm)));
  let role: string | undefined;
  for (const [i, step] of sc.steps.entries()) {
    if (step.as !== undefined)
      role =
        typeof step.as === "string"
          ? step.as === "anon"
            ? undefined
            : sc.actors[step.as]?.role
          : step.as.role;
    if (step.consent || (role !== undefined && roles.get(role)?.isAdmin)) continue;
    const writes = step.create
      ? Object.keys(step.create.data).filter((k) => piiFields.get(step.create?.entity ?? "")?.has(k))
      : step.callFn
        ? Object.keys(step.callFn.args ?? {}).filter((k) => allPii.has(norm(k)))
        : [];
    if (writes.length) errs.push(`Шаг ${i + 1}: запись ПДн (${writes.join(", ")}) без consent: true`);
  }
  return errs;
}

export interface GenerateCall {
  opts: QaAgentOptions;
  spec: AppSpec;
  acs: CardAc[];
  files?: ReadonlyMap<string, string> | undefined;
}

type Parsed = Map<string, { scenarios: Scenario[]; errors: string[] }>;

function parseChecks(spec: AppSpec, acs: CardAc[], args: unknown): Parsed {
  const out: Parsed = new Map(acs.map((a) => [a.id, { scenarios: [], errors: [] }]));
  const list = (args as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(list)) {
    for (const v of out.values()) v.errors.push("submit_checks: нет массива checks");
    return out;
  }
  const byAc = new Map(acs.map((a) => [a.id, a]));
  for (const [i, raw] of list.entries()) {
    const acId = (raw as { acId?: unknown } | null)?.acId;
    const slot = typeof acId === "string" ? out.get(acId) : undefined;
    const ac = typeof acId === "string" ? byAc.get(acId) : undefined;
    if (!slot || !ac) continue;
    const r = scenarioSchema.safeParse(raw);
    if (!r.success) {
      slot.errors.push(...zodIssues(r.error).map((x) => `checks.${i}.${x.path}: ${x.message}`));
      continue;
    }
    const sc = r.data as Scenario;
    const errs = qaValidateScenario(spec, sc, ac);
    if (errs.length) slot.errors.push(...errs.map((e) => `${sc.id}: ${e}`));
    else slot.scenarios.push(sc);
  }
  for (const [id, v] of out)
    if (v.scenarios.length === 0 && v.errors.length === 0) v.errors.push(`Нет сценария для ${id}`);
  return out;
}

async function ask(o: QaAgentOptions, tool: Tool, messages: LlmMessage[], n: number): Promise<RouteOutput> {
  const input: RouteInput = {
    callType: "qa_generate",
    messages: [...messages],
    tools: [tool.definition],
    toolChoice: "required",
    orgPolicy: o.orgPolicy ?? null,
    ctx: o.ctx ?? { orgId: "00000000-0000-4000-8000-000000000000" },
    ...(o.signal ? { signal: o.signal } : {}),
  };
  const out = await (o.runStep ?? identityStep)(`qa_generate#${n}`, () => o.route(input));
  o.onEvent?.({
    type: "llm_call",
    callType: "qa_generate",
    n,
    toolCalls: out.result.toolCalls.length,
    creditsCharged: out.creditsCharged,
    ruFallback: out.ruFallback,
  });
  return out;
}

const acLine = (a: CardAc) => {
  const c = a.check;
  return `- ${a.id} [${c.type}${c.role ? `, роль ${c.role}` : ""}${c.entity ? `, сущность ${c.entity}` : ""}]: ${a.text}`;
};

/** One qa_generate call for all ACs without a cached scenario; invalid ones get one repeat with the errors. */
export async function generateScenarios(call: GenerateCall): Promise<Map<string, CachedAc>> {
  const { opts, spec, acs } = call;
  const messages: LlmMessage[] = [
    { role: "system", content: GENERATE_SYSTEM },
    {
      role: "user",
      content: [
        `Критерии для сценариев: ${acs.map((a) => a.id).join(", ")}`,
        ...acs.map(acLine),
        "",
        qaDigest(spec, call.files),
      ].join("\n"),
    },
  ];
  const result = new Map<string, CachedAc>();
  let pending = acs;
  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
    const out = await ask(opts, submitChecksTool, messages, attempt);
    const mine = out.result.toolCalls.find((c) => c.name === submitChecksTool.name);
    const parsed = parseChecks(spec, pending, mine?.args);
    const retry: CardAc[] = [];
    for (const ac of pending) {
      const p = parsed.get(ac.id) as { scenarios: Scenario[]; errors: string[] };
      if (p.errors.length === 0 || (attempt === 2 && p.scenarios.length > 0))
        result.set(ac.id, { scenarios: p.scenarios });
      else if (attempt === 1) retry.push(ac);
      else result.set(ac.id, { scenarios: [], invalid: p.errors.slice(0, 10) });
    }
    if (retry.length === 0) break;
    const issues = retry.flatMap((a) =>
      (parsed.get(a.id)?.errors ?? []).map((m) => ({ path: a.id, message: m })),
    );
    messages.push({ role: "assistant", content: out.result.text ?? "", toolCalls: out.result.toolCalls });
    for (const c of out.result.toolCalls)
      messages.push({
        role: "tool",
        toolCallId: c.id,
        toolName: c.name,
        content:
          c === mine
            ? toolError(
                "INVALID_ARGS",
                "Часть сценариев не прошла проверку, исправь их.",
                issues.slice(0, 30),
              )
            : toolError("UNKNOWN_TOOL", `Доступен только инструмент ${submitChecksTool.name}.`),
      });
    messages.push({
      role: "user",
      content: `Пришли заново через submit_checks все сценарии для: ${retry.map((a) => a.id).join(", ")}.`,
    });
    pending = retry;
  }
  return result;
}

/** A check G1 reports as error/check_invalid (the steps fail its static validation). */
export function invalidCheck(ac: CardAc): QaCheck {
  return {
    id: `SC-${ac.id}`,
    acId: ac.id,
    kind: ac.check.type === "constraint" ? "constraint" : "scenario",
    level: "G1",
    milestone: ac.check.milestone ?? "M0",
    scenario: { id: `SC-${ac.id}`, acId: ac.id, title: ac.text.slice(0, 140), actors: {}, steps: [] },
  };
}

export function scenarioChecks(ac: CardAc, scenarios: Scenario[]): QaCheck[] {
  const kind = ac.check.type === "constraint" ? "constraint" : "scenario";
  const milestone = ac.check.milestone ?? "M0";
  const seen = new Set<string>();
  return scenarios.map((s, i) => {
    let id = s.id;
    if (seen.has(id)) id = `SC-${ac.id}-${i + 1}`;
    seen.add(id);
    const scenario: Scenario = { ...s, id, acId: ac.id, milestone };
    return { id, acId: ac.id, kind, level: "G1", milestone, scenario };
  });
}
