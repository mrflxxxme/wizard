// Explanation of G1 failures (agents/qa.yaml#explain): code classifies unambiguous facts, qa_explain handles the rest;
// guardrails keep AC and rights from being weakened and pii values out of the text.
import type { AppSpec } from "@wizard/appspec";
import type { Check, QaCheck, Step } from "@wizard/gates";
import { LlmError, type LlmMessage, type RouteInput } from "@wizard/llm";
import { scrubJson } from "@wizard/pii";
import { identityStep } from "../core/index.js";
import type { CardAc } from "./generate.js";
import { EXPLAIN_SYSTEM, qaDigest } from "./prompt.js";
import { explanationSchema, submitExplanationsTool } from "./schemas.js";
import type { Explanation, QaAgentOptions } from "./types.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface ExplainCtx {
  spec: AppSpec;
  acs: readonly CardAc[];
  /** Checks as G1 ran them (QA + derived from the spec), by id. */
  checks: ReadonlyMap<string, QaCheck>;
  /** Validation errors of scenarios QA could not make valid (check_invalid). */
  invalid: ReadonlyMap<string, string[]>;
}

interface Http {
  status: number;
  code?: string;
}

function lastHttp(s: string | undefined): Http | null {
  const all = [...(s ?? "").matchAll(/HTTP (\d{3})(?: ([A-Z][A-Z0-9_]*))?/g)];
  const m = all.at(-1);
  if (!m) return null;
  return { status: Number(m[1]), ...(m[2] ? { code: m[2] } : {}) };
}

const permIndex = (spec: AppSpec, role: string | undefined, entity: string | undefined) =>
  spec.permissions.findIndex((p) => p.role === role && p.entity === entity);
const permTarget = (spec: AppSpec, role?: string, entity?: string) => {
  const i = permIndex(spec, role, entity);
  return i >= 0 ? `/permissions/${i}` : "/permissions";
};
const entityTarget = (spec: AppSpec, entity?: string) => {
  const i = spec.entities.findIndex((e) => e.name === entity);
  return i >= 0 ? `/entities/${i}` : "/entities";
};

/** Action step a scenario failure refers to, and the role acting at that moment. */
function actionAt(q: QaCheck | undefined, n: number): { step: Step; role?: string } | null {
  const steps = q?.scenario?.steps;
  if (!steps || n < 1 || n > steps.length) return null;
  let i = n - 1;
  while (i >= 0 && (steps[i]?.expect || steps[i]?.as !== undefined)) i--;
  const step = steps[i];
  if (!step) return null;
  let role: string | undefined;
  for (const s of steps.slice(0, i)) {
    if (s.as === undefined) continue;
    role = typeof s.as === "string" ? q?.scenario?.actors[s.as]?.role : s.as.role;
  }
  return { step, ...(role ? { role } : {}) };
}

const entityOf = (s: Step) => (s.create ?? s.read ?? s.update ?? s.delete)?.entity;
const fnFile = (spec: AppSpec, name?: string) =>
  (spec.functions ?? []).find((f) => f.name === name)?.file ?? "functions/";

function base(c: Check, category: Explanation["category"], rest: Partial<Explanation>): Explanation {
  const qaOwned = category === "check_invalid" || category === "seed_problem";
  return {
    checkId: c.id,
    ...(c.acId ? { acId: c.acId } : {}),
    category,
    expected: clip(rest.expected ?? c.message_ru, 200),
    actual: clip(rest.actual ?? c.evidence ?? c.message_ru, 300),
    likelyCause: clip(rest.likelyCause ?? c.message_ru, 300),
    fix: qaOwned
      ? { kind: "none", target: "", suggestion: clip(rest.fix?.suggestion ?? "", 300) }
      : (rest.fix ?? { kind: "none", target: "", suggestion: "" }),
    owner: qaOwned ? "qa" : (rest.owner ?? "builder"),
  };
}

/** qa.yaml#explain.step1_classify: null when the facts are ambiguous. */
export function classify(c: Check, x: ExplainCtx): Explanation | null {
  const { spec } = x;
  const q = x.checks.get(c.id);
  const invalid = x.invalid.get(c.id);
  if (invalid || (c.status === "error" && c.evidence?.startsWith("check_invalid")))
    return base(c, "check_invalid", {
      expected: "исполнимый сценарий проверки",
      actual: clip((invalid ?? [c.evidence ?? ""]).join("; "), 300),
      likelyCause: "QA составил сценарий с ошибкой; строитель его не чинит",
      fix: { kind: "none", target: "", suggestion: "QA перегенерирует проверку" },
    });
  if (c.id === "G1-AC-COVER") {
    const i = Number(/^\/acceptance\/(\d+)$/.exec(c.path ?? "")?.[1] ?? -1);
    const acId = spec.acceptance?.[i]?.id;
    return base({ ...c, ...(acId ? { acId } : {}) }, "check_invalid", {
      expected: "у критерия есть исполнимая проверка",
      likelyCause: "QA не сформировал исполнимую проверку для критерия",
    });
  }
  if (c.status === "error") {
    if (/SEED_PII|начальные данные/.test(c.message_ru))
      return base(c, "seed_problem", { likelyCause: "Начальные данные проверки не прошли DLP" });
    if (/не собирается/.test(c.message_ru)) {
      const file = /functions\/[\w/-]+\.ts/.exec(c.evidence ?? "")?.[0] ?? "functions/";
      return base(c, "function_error", {
        expected: "система собирается",
        likelyCause: "Код функций не собирается",
        fix: { kind: "code", target: file, suggestion: "Исправьте ошибку сборки в коде функции" },
      });
    }
    // Environment failures (no runtime, time budget, internal) are not the builder's to fix.
    return base(c, "check_invalid", { likelyCause: "Сбой среды проверки, строителю исправлять нечего" });
  }
  if (c.id === "G1-FN-01") {
    return base(c, "function_error", {
      expected: "запрос отвечает без ошибки сервера",
      likelyCause: "Функция падает на допустимых аргументах",
      fix: {
        kind: "code",
        target: c.file ?? "functions/",
        suggestion: "Приложите стек из журнала runtime и обработайте пустые/отсутствующие данные",
      },
    });
  }
  const http = lastHttp(c.evidence);
  const ok = http !== null && http.status < 300;
  const denied = http !== null && (http.status === 401 || http.status === 403);
  const unknown = http?.code === "UNKNOWN_FIELD" || http?.code === "UNKNOWN_ENTITY";

  if (q?.kind === "permission" && q.probe) {
    const target = permTarget(spec, q.role, q.entity);
    const p = q.probe;
    if (unknown)
      return base(c, "missing_entity_or_field", {
        likelyCause: `Нет сущности или поля, к которым обращается проверка (${http?.code})`,
        fix: {
          kind: "ops",
          target: entityTarget(spec, q.entity),
          suggestion: "Добавьте сущность/поле из карточки",
        },
      });
    if (p.kind === "op" && p.expect === "deny" && ok)
      return base(c, "permission_too_broad", {
        expected: `роль ${q.role}: ${p.op} ${q.entity} запрещено`,
        likelyCause: `У роли ${q.role} есть право ${p.op} на ${q.entity}, а критерий это запрещает`,
        fix: {
          kind: "ops",
          target,
          suggestion: `Уберите ${p.op} из прав роли ${q.role} на ${q.entity} (set_permission)`,
        },
      });
    if (p.kind === "op" && p.expect === "allow" && denied)
      return base(c, "permission_too_narrow", {
        expected: `роль ${q.role}: ${p.op} ${q.entity} разрешено`,
        likelyCause: `У роли ${q.role} нет права ${p.op} на ${q.entity}, которое требует карточка`,
        fix: {
          kind: "ops",
          target,
          suggestion: `Добавьте ${p.op} в права роли ${q.role} на ${q.entity}, как в карточке`,
        },
      });
    if (p.kind === "row" || p.kind === "hidden" || p.kind === "ro") {
      const what = { row: "rowFilter", hidden: "hiddenFields", ro: "readonlyFields" }[p.kind];
      return base(c, "permission_too_broad", {
        expected: c.message_ru,
        likelyCause: `Права роли ${q.role} на ${q.entity} не ограничивают доступ (${what})`,
        fix: { kind: "ops", target, suggestion: `Задайте ${what} в правах роли ${q.role} на ${q.entity}` },
      });
    }
    return null;
  }

  if (q?.scenario) {
    const m = /^шаг (\d+): ожидалось (.+?), получено (.+)$/.exec(c.evidence ?? "");
    if (!m) return null;
    const [, nStr, want = "", got = ""] = m;
    const at = actionAt(q, Number(nStr));
    if (!at) return null;
    const { step, role } = at;
    const entity = entityOf(step);
    const expected = `шаг ${nStr}: ${want}`;
    if (unknown)
      return base(c, "missing_entity_or_field", {
        expected,
        actual: got,
        likelyCause: `Сценарий обращается к полю или сущности, которых нет (${http?.code})`,
        fix: {
          kind: "ops",
          target: entityTarget(spec, entity),
          suggestion: "Добавьте поле/сущность из карточки",
        },
      });
    const jobs = jobExplanation(c, x, q, { step, entity, want, got, expected, http, n: Number(nStr) });
    if (jobs) return jobs;
    if (
      step.callFn &&
      http &&
      (http.status >= 500 || (http.status === 400 && /^(ok\/created|status=(ok|created)|error=)/.test(want)))
    ) {
      const file = fnFile(spec, step.callFn.name);
      return base(c, "function_error", {
        expected,
        actual: got,
        likelyCause: `Функция ${step.callFn.name} ${http.status >= 500 ? "падает" : `возвращает ошибку ${http.code ?? ""}`.trim()} вместо ожидаемого результата`,
        fix: {
          kind: "code",
          target: file,
          suggestion: `Проверьте логику ${file} против критерия ${q.acId ?? ""}`.trim(),
        },
      });
    }
    if (entity && http && http.status >= 500)
      return base(c, "function_error", {
        expected,
        actual: got,
        likelyCause: "Ошибка сервера при работе с данными",
      });
    if (/^status=(denied|not_found)$/.test(want) && ok && entity && role)
      return base(c, "permission_too_broad", {
        expected,
        actual: got,
        likelyCause: `Роль ${role} получает доступ к ${entity}, который критерий запрещает`,
        fix: {
          kind: "ops",
          target: permTarget(spec, role, entity),
          suggestion: `Ограничьте права роли ${role} на ${entity} (ops или rowFilter)`,
        },
      });
    if (denied && !/denied/.test(want)) {
      if (step.callFn)
        return base(c, "permission_too_narrow", {
          expected,
          actual: got,
          likelyCause: `Роль ${role ?? "?"} не может вызвать ${step.callFn.name}`,
          fix: {
            kind: "ops",
            target: `/functions/${(spec.functions ?? []).findIndex((f) => f.name === step.callFn?.name)}`,
            suggestion: `Добавьте роль ${role ?? ""} в roles функции, как требует карточка`.replace(
              "  ",
              " ",
            ),
          },
        });
      if (entity && role)
        return base(c, "permission_too_narrow", {
          expected,
          actual: got,
          likelyCause: `У роли ${role} нет нужного права на ${entity}`,
          fix: {
            kind: "ops",
            target: permTarget(spec, role, entity),
            suggestion: `Добавьте право роли ${role} на ${entity}, как в карточке`,
          },
        });
    }
    if (/^status=(invalid|conflict)$/.test(want) && ok && entity)
      return base(c, "validation_mismatch", {
        expected,
        actual: got,
        likelyCause: `Система принимает данные ${entity}, которые критерий считает недопустимыми`,
        fix: {
          kind: "ops",
          target: entityTarget(spec, entity),
          suggestion: "Задайте ограничение поля (required/unique/min/max/maxLength/enum)",
        },
      });
    return null;
  }
  return null;
}

const piiOf = (f: { pii?: string | undefined; type: string }) =>
  f.pii ?? (f.type === "file" ? "basic" : "none");

interface Fact {
  step: Step;
  entity: string | undefined;
  want: string;
  got: string;
  expected: string;
  http: Http | null;
  /** 1-based number of the failed step. */
  n: number;
}

/**
 * Workflows, time and connector mocks (M1): runner failures after runWorkflows/advanceTime, missing outbox
 * messages, pii fields still present after advanceTime (retention), simulate answered with an error.
 */
function jobExplanation(c: Check, x: ExplainCtx, q: QaCheck, f: Fact): Explanation | null {
  const { spec } = x;
  const { step, entity, want, got, expected, http } = f;
  const workflows = spec.workflows ?? [];
  if ((step.runWorkflows !== undefined || step.advanceTime !== undefined) && http && http.status >= 500) {
    const wf = /\(воркфлоу ([a-z][a-z0-9_]*), шаг (\d+)/.exec(got);
    const fn = /\(функция ([A-Za-z0-9]+)\)/.exec(got);
    const wi = wf ? workflows.findIndex((w) => w.name === wf[1]) : -1;
    const si = wf ? Number(wf[2]) - 1 : -1;
    const ws = workflows[wi]?.steps[si];
    const fnName = fn?.[1] ?? (ws?.type === "function" ? String(ws.params?.name ?? "") : undefined);
    if (fnName !== undefined) {
      const file = fnFile(spec, fnName);
      return base(c, "function_error", {
        expected,
        actual: got,
        likelyCause: `Функция ${fnName} падает при запуске автоматизацией (${http.code ?? http.status})`,
        fix: {
          kind: "code",
          target: file,
          suggestion: `Проверьте ${file}: аргументы из автоматизации и пустые данные`,
        },
      });
    }
    if (wf)
      return base(c, "workflow_not_triggered", {
        expected,
        actual: got,
        likelyCause: `Шаг ${si + 1} автоматизации «${wf[1]}» завершился ошибкой ${http.code ?? http.status}`,
        fix: {
          kind: "ops",
          target: wi >= 0 ? `/workflows/${wi}/steps/${si}` : "/workflows",
          suggestion:
            "Проверьте параметры шага: интеграцию, получателя ($record.<ссылка на users>), функцию и аргументы",
        },
      });
  }
  const out = /^сообщений ([^:]+): /.exec(want);
  if (out) {
    const connector = out[1] as string;
    const integrations = new Set(
      (spec.integrations ?? [])
        .filter((i) => i.connector === connector || i.name === connector)
        .map((i) => i.name),
    );
    const sends = (w: (typeof workflows)[number]) =>
      w.steps.some(
        (s) =>
          (s.type === "notify" || s.type === "connector") &&
          integrations.has(String(s.params?.integration ?? "")),
      );
    // Prefer the workflow triggered by an entity the scenario wrote before the failed step.
    const written = new Set(
      (q.scenario?.steps ?? [])
        .slice(0, f.n)
        .map((s) => (s.create ?? s.update)?.entity)
        .filter(Boolean),
    );
    const own = workflows.findIndex((w) => sends(w) && written.has(w.trigger.entity));
    const wi = own >= 0 ? own : workflows.findIndex(sends);
    const w = workflows[wi];
    return base(c, "workflow_not_triggered", {
      expected,
      actual: `сообщений: ${got}`,
      likelyCause: w
        ? `Автоматизация «${w.name}» не отправила сообщение: не сработал триггер или условие if`
        : `Нет автоматизации, которая отправляет сообщение через ${connector}`,
      fix: {
        kind: "ops",
        target: w ? `/workflows/${wi}` : "/workflows",
        suggestion: w
          ? "Сверьте trigger (entity, field, equals) и if шага с критерием"
          : `Добавьте автоматизацию с шагом notify через ${connector}`,
      },
    });
  }
  const afterTime = (q.scenario?.steps ?? []).slice(0, f.n).some((s) => s.advanceTime !== undefined);
  const field = /^([a-z_][a-z0-9_]*)=/.exec(want)?.[1];
  const e = spec.entities.find((y) => y.name === entity);
  const ef = e?.fields.find((y) => y.name === field);
  if (afterTime && e && ef && piiOf(ef) !== "none")
    return base(c, "workflow_not_triggered", {
      expected,
      actual: got,
      likelyCause: e.retention
        ? `Срок хранения ${e.name} не сработал: проверьте deleteAfterDays, anchorField и mode`
        : `У ${e.name} не задан срок хранения персональных данных`,
      fix: {
        kind: "ops",
        target: `${entityTarget(spec, e.name)}/retention`,
        suggestion: "Задайте retention по критерию: deleteAfterDays, anchorField, mode: anonymize",
      },
    });
  if (step.simulate && http && http.status >= 400 && !/^(status|error)=/.test(want)) {
    const ii = (spec.integrations ?? []).findIndex((i) => i.connector === step.simulate?.connector);
    return base(c, "connector_mock_mismatch", {
      expected,
      actual: got,
      likelyCause: `Событие ${step.simulate.connector}/${step.simulate.event} не принято системой`,
      fix: {
        kind: "ops",
        target: ii >= 0 ? `/integrations/${ii}` : "/integrations",
        suggestion: "Проверьте настройки интеграции: привязки (bindings), сущность и поле токена",
      },
    });
  }
  return null;
}

/** Guardrails (qa.yaml#explain.guardrails) and limits for an explanation from the model. */
export function guard(e: Explanation): Explanation {
  let out: Explanation = {
    ...e,
    expected: clip(e.expected, 200),
    actual: clip(e.actual, 300),
    likelyCause: clip(e.likelyCause, 300),
    fix: { ...e.fix, suggestion: clip(e.fix.suggestion, 300) },
  };
  const weakensAc =
    out.fix.target.startsWith("/acceptance") ||
    /(удал|ослаб|убер|измени)\S*\s+(\S+\s+)?критери/i.test(out.fix.suggestion);
  if (weakensAc || out.category === "check_invalid" || out.category === "seed_problem")
    out = {
      ...out,
      owner: "qa",
      fix: {
        kind: "none",
        target: "",
        suggestion: weakensAc ? "Конфликт критерия и прав: решает QA через оркестратор" : out.fix.suggestion,
      },
    };
  return scrubJson(out).value;
}

async function askExplain(o: QaAgentOptions, messages: LlmMessage[]) {
  const input: RouteInput = {
    callType: "qa_explain",
    messages,
    tools: [submitExplanationsTool.definition],
    toolChoice: "required",
    orgPolicy: o.orgPolicy ?? null,
    ctx: o.ctx ?? { orgId: "00000000-0000-4000-8000-000000000000" },
    ...(o.signal ? { signal: o.signal } : {}),
  };
  const out = await (o.runStep ?? identityStep)("qa_explain#1", () => o.route(input));
  o.onEvent?.({
    type: "llm_call",
    callType: "qa_explain",
    n: 1,
    toolCalls: out.result.toolCalls.length,
    creditsCharged: out.creditsCharged,
    ruFallback: out.ruFallback,
  });
  return out;
}

const fallback = (c: Check): Explanation =>
  base(c, "wrong_status_flow", {
    likelyCause: "Результат не совпал с критерием; причина не определена автоматически",
    fix: { kind: "code", target: "", suggestion: "Сравните шаги сценария с логикой функций и правами" },
  });

/** step2_llm: one qa_explain call for the ambiguous failures; missing/invalid answers fall back to a generic one. */
export async function explainAmbiguous(
  o: QaAgentOptions,
  x: ExplainCtx,
  failed: Check[],
): Promise<Explanation[]> {
  const facts = failed.map((c) => {
    const q = x.checks.get(c.id);
    const ac = x.acs.find((a) => a.id === c.acId);
    return {
      checkId: c.id,
      ...(c.acId ? { acId: c.acId, acText: ac?.text } : {}),
      message_ru: c.message_ru,
      ...(c.evidence ? { evidence: c.evidence } : {}),
      ...(q?.scenario ? { steps: q.scenario.steps, actors: q.scenario.actors } : {}),
      ...(q?.probe ? { role: q.role, entity: q.entity, probe: q.probe } : {}),
    };
  });
  const messages: LlmMessage[] = [
    { role: "system", content: EXPLAIN_SYSTEM },
    {
      role: "user",
      content: `Упавшие проверки:\n${JSON.stringify(facts)}\n\n${qaDigest(x.spec)}`,
    },
  ];
  const byId = new Map<string, Explanation>();
  try {
    const out = await askExplain(o, messages);
    const call = out.result.toolCalls.find((c) => c.name === submitExplanationsTool.name);
    const list = (call?.args as { explanations?: unknown } | undefined)?.explanations;
    for (const raw of Array.isArray(list) ? list : []) {
      const r = explanationSchema.safeParse(raw);
      if (!r.success) continue;
      const c = failed.find((f) => f.id === r.data.checkId);
      if (!c || byId.has(c.id)) continue;
      const e: Explanation = { ...r.data, ...(c.acId ? { acId: c.acId } : {}) };
      byId.set(c.id, guard(e));
    }
  } catch (e) {
    if (o.signal?.aborted || (e instanceof LlmError && e.code === "BUDGET_EXCEEDED")) throw e;
  }
  return failed.map((c) => byId.get(c.id) ?? fallback(c));
}
