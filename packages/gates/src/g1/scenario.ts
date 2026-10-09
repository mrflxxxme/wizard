// Scenario DSL executor (specs/quality/gates.yaml#scenario_dsl) against a runtime through G1Env.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { qrOfflineHash } from "@wizard/connectors";
import type { JobRunReport } from "../types.js";
import { type Actor, errorCode, type G1Env, type HttpResult } from "./env.js";
import { validateSeedHint } from "./seed.js";
import type { Expect, Scenario, Seed, Step } from "./types.js";

export const STEP_TIMEOUT_MS = 5_000;
export const SCENARIO_TIMEOUT_MS = 20_000;
/** advanceTime upper bound: the longest retention (3650 days) plus a margin. */
export const MAX_ADVANCE_MINUTES = 4000 * 1440;

const ACTIONS = [
  "as",
  "create",
  "read",
  "update",
  "delete",
  "callFn",
  "simulate",
  "runWorkflows",
  "advanceTime",
  "expect",
] as const;
type ActionKey = (typeof ACTIONS)[number];
const ALIAS_RE = /^[a-z][a-z0-9_]*$/;
const VAR_RE = /^\$([a-z][a-z0-9_]*)(?:\.([A-Za-z0-9_.]+))?$/;
const SEED_RE = /^\$seed\.([a-z][a-z0-9_]*)\[(\d+)\]\.([a-z_][a-z0-9_]*)$/;
const NOW_RE = /^\$now(?:([+-])(\d+)m)?$/;

export function actionOf(step: Step): ActionKey | null {
  const keys = ACTIONS.filter((k) => Object.hasOwn(step, k));
  return keys.length === 1 ? (keys[0] as ActionKey) : null;
}

function refsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && v.startsWith("$")) out.push(v);
  else if (Array.isArray(v)) for (const x of v) refsIn(x, out);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v)) refsIn(x, out);
  return out;
}

/** Static validation (qa.yaml#checks.from_acceptance.scenario.validate); Russian messages, empty = valid. */
export function validateScenario(spec: AppSpec, sc: Scenario): string[] {
  const errs: string[] = [];
  const roles = new Set(spec.roles.map((r) => r.name));
  const entities = new Map(spec.entities.map((e) => [e.name, e]));
  const fns = new Set((spec.functions ?? []).map((f) => f.name));
  const aliases = new Set<string>();
  for (const [alias, a] of Object.entries(sc.actors ?? {})) {
    if (!ALIAS_RE.test(alias)) errs.push(`Недопустимое имя участника «${alias}»`);
    if (!roles.has(a?.role)) errs.push(`Участник «${alias}»: роли «${a?.role}» нет в системе`);
    aliases.add(alias);
  }
  if (sc.seedHints !== undefined) {
    if (!Array.isArray(sc.seedHints) || sc.seedHints.length > 20)
      errs.push("seedHints: не больше 20 подсказок");
    else for (const h of sc.seedHints) errs.push(...validateSeedHint(spec, h));
  }
  if (!Array.isArray(sc.steps) || sc.steps.length < 1 || sc.steps.length > 40)
    return [...errs, "В сценарии должно быть от 1 до 40 шагов"];
  const defined = new Set<string>();
  let hadAction = false;
  for (const [i, step] of sc.steps.entries()) {
    const n = i + 1;
    if (step === null || typeof step !== "object") {
      errs.push(`Шаг ${n}: ожидается объект`);
      continue;
    }
    if (Object.hasOwn(step, "actors")) errs.push(`Шаг ${n}: actors — поле сценария, а не шаг`);
    const action = actionOf(step);
    const extra = Object.keys(step).filter(
      (k) => !(ACTIONS as readonly string[]).includes(k) && k !== "consent",
    );
    if (!action || extra.length) {
      errs.push(`Шаг ${n}: должно быть ровно одно действие`);
      continue;
    }
    if (
      step.consent !== undefined &&
      !(step.consent === true && (action === "create" || action === "callFn"))
    )
      errs.push(`Шаг ${n}: consent допустим только как true у create или callFn`);
    for (const ref of refsIn(step)) {
      if (NOW_RE.test(ref)) continue;
      const s = SEED_RE.exec(ref);
      if (s) {
        if (s[1] !== "users" && !entities.has(s[1] as string))
          errs.push(`Шаг ${n}: в ${ref} нет сущности «${s[1]}»`);
        continue;
      }
      const m = VAR_RE.exec(ref);
      if (!m || (!aliases.has(m[1] as string) && !defined.has(m[1] as string)))
        errs.push(`Шаг ${n}: переменная ${ref} не определена раньше`);
    }
    const entityStep = step.create ?? step.read ?? step.update ?? step.delete;
    if (entityStep) {
      const e = entities.get(entityStep.entity);
      if (!e) errs.push(`Шаг ${n}: сущности «${entityStep.entity}» нет в системе`);
      const data = (step.create ?? step.update)?.data ?? step.read?.where ?? {};
      if (e && data && typeof data === "object") {
        for (const k of Object.keys(data)) {
          if (
            !e.fields.some((f) => f.name === k) &&
            !["id", "created_at", "updated_at", "created_by"].includes(k)
          )
            errs.push(`Шаг ${n}: у «${e.name}» нет поля «${k}»`);
        }
      }
    }
    if (
      step.advanceTime !== undefined &&
      !(
        Number.isInteger(step.advanceTime?.minutes) &&
        step.advanceTime.minutes >= 1 &&
        step.advanceTime.minutes <= MAX_ADVANCE_MINUTES
      )
    )
      errs.push(`Шаг ${n}: advanceTime.minutes — целое число от 1 до ${MAX_ADVANCE_MINUTES}`);
    if (
      step.runWorkflows !== undefined &&
      (step.runWorkflows === null ||
        typeof step.runWorkflows !== "object" ||
        Object.keys(step.runWorkflows).length > 0)
    )
      errs.push(`Шаг ${n}: runWorkflows — пустой объект {}`);
    if (step.callFn && !fns.has(step.callFn.name))
      errs.push(`Шаг ${n}: функции «${step.callFn.name}» нет в системе`);
    if (step.as !== undefined) {
      const a = step.as;
      if (typeof a === "string" ? a !== "anon" && !aliases.has(a) : !roles.has(a?.role))
        errs.push(`Шаг ${n}: неизвестный участник ${JSON.stringify(a)}`);
    }
    if (action === "expect" && !hadAction) errs.push(`Шаг ${n}: expect без предшествующего действия`);
    if (action !== "expect" && action !== "as") hadAction = true;
    const save = (step.create ?? step.read ?? step.update ?? step.callFn)?.save;
    if (save !== undefined) {
      if (!ALIAS_RE.test(save) || save === "seed" || save === "now")
        errs.push(`Шаг ${n}: недопустимое имя ${save}`);
      defined.add(save);
    }
  }
  return errs;
}

export interface ScenarioOutcome {
  status: "pass" | "fail" | "error";
  message_ru: string;
  evidence?: string;
  step?: number;
}

export interface ScenarioDeps {
  seed: Seed | null;
  consent: { policyVersion: string; textHash: string } | null;
  now: Date;
  /** Field names whose values never go into evidence (pii ≠ none). */
  piiNames: ReadonlySet<string>;
  stepTimeoutMs?: number;
  scenarioTimeoutMs?: number;
}

class StepError extends Error {
  constructor(
    readonly status: "fail" | "error",
    message: string,
    readonly evidence?: string,
  ) {
    super(message);
  }
}

interface Last {
  step: number;
  action: ActionKey;
  res: HttpResult;
  /** Item, list or function result the expect/save looks at. */
  value: unknown;
}

const PII_KEY_RE = /name|email|phone|address|fio|фио|телефон|адрес/i;

function show(key: string, v: unknown, pii: ReadonlySet<string>): string {
  // An empty value carries no PII: «null» vs «скрыто» is what tells a retention failure (AC6) apart.
  if (v !== null && v !== undefined && (pii.has(key) || PII_KEY_RE.test(key))) return "«скрыто»";
  const s = JSON.stringify(v);
  return s === undefined ? "нет" : s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function got(res: HttpResult): string {
  const code = errorCode(res);
  const job = (res.body as { failed?: JobRunReport["failed"] } | null)?.failed?.[0];
  const where = job
    ? job.step !== undefined
      ? ` (воркфлоу ${job.name}, шаг ${job.step + 1}${job.stepType ? ` ${job.stepType}` : ""})`
      : ` (${job.kind === "function" ? "функция" : "задание"} ${job.name})`
    : "";
  // VALIDATION_FAILED: which fields and rules (names and codes only — values stay out of the evidence).
  const fields = (
    res.body as { error?: { details?: { fields?: { field?: unknown; code?: unknown }[] } } } | null
  )?.error?.details?.fields;
  const which = Array.isArray(fields)
    ? fields
        .slice(0, 4)
        .map((f) => `${String(f.field ?? "?")}: ${String(f.code ?? "?")}`)
        .join(", ")
    : "";
  return `HTTP ${res.status}${code ? ` ${code}` : ""}${which ? ` (${which})` : ""}${where}`;
}

/** Messages of FUNCTIONS_DISABLED from apps/runtime itself (exec/host.ts, the sandbox orchestrator and executor). */
const RUNTIME_REASONS: ReadonlySet<string> = new Set([
  "Функции системы не загружены",
  "Функции системы временно недоступны",
  "Песочница функций перезапускается",
  "Песочница функций недоступна",
  "Песочница функций не запустилась",
  "Песочница функций не запустилась вовремя",
  "Песочница заполнена: функции системы временно недоступны",
  "Код системы не помещается в песочницу",
  "Код системы не запускается в песочнице",
]);

/**
 * What a 503 FUNCTIONS_DISABLED means for this runtime. Functions are switched off only in a runtime with neither a
 * sandbox (RuntimeHandle.renderer, M2-19) nor unsafe local exec; otherwise they were unavailable for this call, and the
 * runtime's own message says why (a pod not started, a full sandbox quota…).
 */
function functionsDisabled(env: G1Env, detail?: string): string {
  // Only the runtime's own reasons are quoted: system code can throw FUNCTIONS_DISABLED with any message.
  const why = detail && RUNTIME_REASONS.has(detail.trim()) ? `: ${detail.trim()}` : "";
  if (env.runtime.renderer) return `Песочница функций была недоступна${why}`;
  if (env.runtime.env?.unsafeLocalExec === true) return `Функции системы не загрузились в runtime${why}`;
  return "Функции системы отключены в runtime (нужен WIZARD_UNSAFE_LOCAL_EXEC=1)";
}

function sameValue(want: unknown, have: unknown): boolean {
  if (want === null || have === null || want === undefined || have === undefined) return want === have;
  if (typeof want === "number" && typeof have === "string" && have.trim() !== "")
    return Number(have) === want;
  if (typeof want === "string" && typeof have === "number") return Number(want) === have;
  return JSON.stringify(want) === JSON.stringify(have);
}

const STATUS_NAMES: Record<string, (r: HttpResult) => boolean> = {
  ok: (r) => r.status === 200 || r.status === 204,
  created: (r) => r.status === 201,
  denied: (r) => r.status === 401 || r.status === 403,
  not_found: (r) => r.status === 404,
  invalid: (r) => {
    const c = errorCode(r) ?? "";
    return r.status === 422 && (c === "VALIDATION_FAILED" || c === "UNKNOWN_FIELD" || c.startsWith("FIELD_"));
  },
  conflict: (r) => r.status === 409,
  limit: (r) => (r.status === 422 && errorCode(r) === "LIMIT_EXCEEDED") || r.status === 429,
};

function getPath(v: unknown, path: string | undefined): unknown {
  if (!path) return v;
  let cur = v;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export async function runScenario(env: G1Env, sc: Scenario, deps: ScenarioDeps): Promise<ScenarioOutcome> {
  const stepTimeout = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const deadline = Date.now() + (deps.scenarioTimeoutMs ?? SCENARIO_TIMEOUT_MS);
  const spec = env.spec;
  // Own system only: positions in the shared outbox move when another gate's messages are dropped (B2-41).
  const outboxStart = env.outbox().length;
  const actors = new Map<string, Actor>();
  const adhoc = new Map<string, Actor>();
  const vars = new Map<string, unknown>();
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  // Scenario time: $now = deps.now + offset; the job runner never runs behind the DB clock that stamps rows.
  const baseMs = Math.max(deps.now.getTime(), Date.now());
  let offsetMin = 0;

  const actorFor = async (role: string): Promise<Actor> =>
    publicRoles.has(role) ? env.anonymous(role) : env.newUser(role);
  for (const [alias, a] of Object.entries(sc.actors ?? {})) actors.set(alias, await actorFor(a.role));

  const resolve = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$")) {
      const now = NOW_RE.exec(v);
      if (now) {
        const delta = now[2] ? Number(now[2]) * 60_000 * (now[1] === "-" ? -1 : 1) : 0;
        return new Date(deps.now.getTime() + offsetMin * 60_000 + delta).toISOString();
      }
      const s = SEED_RE.exec(v);
      if (s) {
        const list =
          s[1] === "users"
            ? (deps.seed?.users as unknown as Record<string, unknown>[] | undefined)
            : deps.seed?.rows[s[1] as string];
        const row = list?.[Number(s[2])];
        if (!row) throw new StepError("error", `В начальных данных нет ${v}`);
        return row[s[3] as string];
      }
      const m = VAR_RE.exec(v);
      if (m) {
        const actor = actors.get(m[1] as string);
        if (actor) return m[2] === "id" ? actor.id : undefined;
        if (vars.has(m[1] as string)) return getPath(vars.get(m[1] as string), m[2]);
      }
      throw new StepError("error", `Переменная ${v} не определена`);
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };

  let current: Actor = env.anonymous();
  let last: Last | null = null;
  let checked = true;

  const implicit = () => {
    if (!last || checked) return;
    checked = true;
    const ok = [200, 201, 204].includes(last.res.status);
    if (!ok)
      throw new StepError(
        "fail",
        `Шаг ${last.step} (${last.action}) завершился ошибкой`,
        `шаг ${last.step}: ожидалось ok/created, получено ${got(last.res)}`,
      );
  };

  const withConsent = (step: Step, body: Record<string, unknown>) =>
    step.consent && deps.consent ? { ...body, _consent: deps.consent } : body;

  async function act(step: Step, action: ActionKey): Promise<{ res: HttpResult; value: unknown }> {
    const enc = encodeURIComponent;
    switch (action) {
      case "create": {
        const c = step.create as NonNullable<Step["create"]>;
        const res = await env.request(
          current,
          "POST",
          `/api/data/${enc(c.entity)}`,
          withConsent(step, resolve(c.data ?? {}) as Record<string, unknown>),
        );
        return { res, value: (res.body as { item?: unknown } | null)?.item };
      }
      case "read": {
        const r = step.read as NonNullable<Step["read"]>;
        if (r.id !== undefined) {
          const res = await env.request(
            current,
            "GET",
            `/api/data/${enc(r.entity)}/${enc(String(resolve(r.id)))}`,
          );
          return { res, value: (res.body as { item?: unknown } | null)?.item };
        }
        const q = new URLSearchParams({ limit: "100" });
        for (const [k, x] of Object.entries((resolve(r.where ?? {}) as Record<string, unknown>) ?? {}))
          q.set(`filter[${k}]`, x === null ? "null" : String(x));
        const res = await env.request(current, "GET", `/api/data/${enc(r.entity)}?${q}`);
        return { res, value: (res.body as { items?: unknown } | null)?.items };
      }
      case "update": {
        const u = step.update as NonNullable<Step["update"]>;
        const res = await env.request(
          current,
          "PATCH",
          `/api/data/${enc(u.entity)}/${enc(String(resolve(u.id)))}`,
          withConsent(step, resolve(u.data ?? {}) as Record<string, unknown>),
        );
        return { res, value: (res.body as { item?: unknown } | null)?.item };
      }
      case "delete": {
        const d = step.delete as NonNullable<Step["delete"]>;
        const res = await env.request(
          current,
          "DELETE",
          `/api/data/${enc(d.entity)}/${enc(String(resolve(d.id)))}`,
        );
        return { res, value: null };
      }
      case "callFn": {
        const f = step.callFn as NonNullable<Step["callFn"]>;
        const res = await env.request(
          current,
          "POST",
          `/api/fn/${enc(f.name)}`,
          withConsent(step, { args: resolve(f.args ?? {}) }),
        );
        if (res.status === 503 && errorCode(res) === "FUNCTIONS_DISABLED")
          throw new StepError(
            "error",
            functionsDisabled(env, (res.body as { error?: { message?: string } } | null)?.error?.message),
          );
        return { res, value: (res.body as { result?: unknown } | null)?.result };
      }
      case "simulate":
        return simulate(step.simulate as NonNullable<Step["simulate"]>);
      case "advanceTime":
        offsetMin += (step.advanceTime as NonNullable<Step["advanceTime"]>).minutes;
        return jobs();
      default:
        return jobs();
    }
  }

  /** runWorkflows/advanceTime: one runner pass at the scenario time; a failed job answers like HTTP 500. */
  async function jobs(): Promise<{ res: HttpResult; value: unknown }> {
    const r = await env.runJobs(new Date(baseMs + offsetMin * 60_000), new Date(baseMs));
    if (!r) throw new StepError("error", "Runtime не исполняет воркфлоу и задания по времени");
    const f = r.failed[0];
    if (f?.code === "FUNCTIONS_DISABLED") throw new StepError("error", functionsDisabled(env));
    if (f) return { res: { status: 500, body: { error: { code: f.code }, failed: r.failed } }, value: r };
    return { res: { status: 200, body: r }, value: r };
  }

  async function simulate(s: NonNullable<Step["simulate"]>): Promise<{ res: HttpResult; value: unknown }> {
    const data = (resolve(s.data ?? {}) as Record<string, unknown>) ?? {};
    const integrations = (spec.integrations ?? []).filter((i) => i.connector === s.connector);
    if (s.connector === "qr" && s.event === "checkin") {
      const integ = integrations[0];
      const cfg = integ?.config as { entity?: string; tokenField?: string } | undefined;
      if (!integ || !cfg?.entity || !cfg.tokenField)
        throw new StepError("error", "В системе нет QR-интеграции");
      const id = data[cfg.entity] ?? data.ticket ?? data.id;
      const token = await env.readColumn(cfg.entity, cfg.tokenField, String(id));
      const res = await env.request(
        current,
        "POST",
        `/_wizard/qr/check?integration=${encodeURIComponent(integ.name)}`,
        {
          payload: token ?? "missing",
          deviceId: String(data.deviceId ?? `g1-${env.runId}`),
          ...(typeof data.gate === "string" ? { checkpoint: data.gate } : {}),
        },
      );
      return { res, value: res.body };
    }
    // M2-03: offline scans of the listed carriers sent like a scanner device (connectors/qr.yaml#offline.sync_protocol).
    if (s.connector === "qr" && s.event === "sync") {
      const integ = integrations[0];
      const cfg = integ?.config as { entity?: string; tokenField?: string } | undefined;
      if (!integ || !cfg?.entity || !cfg.tokenField)
        throw new StepError("error", "В системе нет QR-интеграции");
      const events = [];
      for (const e of Array.isArray(data.events) ? (data.events as Record<string, unknown>[]) : []) {
        const id = e[cfg.entity] ?? e.ticket ?? e.id;
        const token = await env.readColumn(cfg.entity, cfg.tokenField, String(id));
        events.push({
          clientEventId: randomUUID(),
          h: qrOfflineHash(token) ?? "A".repeat(22),
          scannedAt: new Date().toISOString(),
          ...(typeof e.gate === "string" ? { gate: e.gate } : {}),
        });
      }
      const res = await env.request(
        current,
        "POST",
        `/_wizard/qr/sync?integration=${encodeURIComponent(integ.name)}`,
        { deviceId: String(data.deviceId ?? `g1-${env.runId}`).slice(0, 64), events },
      );
      return { res, value: res.body };
    }
    if (s.connector === "yookassa" && s.event === "payment.succeeded") {
      for (const integ of integrations) {
        const bindings = (integ.config as { bindings?: { id: string }[] }).bindings ?? [];
        const b =
          bindings.find((x) => data[x.id] !== undefined) ??
          (typeof data.binding === "string" ? bindings.find((x) => x.id === data.binding) : undefined);
        if (!b) continue;
        const id = String(data[b.id] ?? data.id);
        // V3-23: an order of a visitor without login is paid by the buyer's secret the order gave him.
        const token = typeof data.token === "string" ? { token: data.token } : {};
        const start = await env.request(current, "POST", `/api/pay/${encodeURIComponent(integ.name)}`, {
          binding: b.id,
          id,
          ...token,
        });
        if (start.status !== 200) return { res: start, value: start.body };
        const res = await env.request(current, "POST", "/_wizard/pay-mock", { binding: b.id, id, ...token });
        return { res, value: res.body };
      }
      throw new StepError("error", "Нет привязки ЮKassa для события оплаты");
    }
    throw new StepError("error", `Событие ${s.connector}/${s.event} мок-коннектора в M0 не поддерживается`);
  }

  function checkExpect(n: number, e: Expect): void {
    if (!last) throw new StepError("error", `Шаг ${n}: expect без действия`);
    const l = last;
    const fail = (what: string, have: string) =>
      new StepError(
        "fail",
        `Шаг ${n}: результат шага ${l.step} не совпал с ожиданием`,
        `шаг ${n}: ожидалось ${what}, получено ${have}`,
      );
    if (e.status !== undefined) {
      const okStatus =
        typeof e.status === "number" ? l.res.status === e.status : STATUS_NAMES[e.status]?.(l.res);
      if (!okStatus) throw fail(`status=${e.status}`, got(l.res));
    }
    if (e.error !== undefined && errorCode(l.res) !== e.error) throw fail(`error=${e.error}`, got(l.res));
    const needsBody = e.fields !== undefined || e.absentFields !== undefined || e.count !== undefined;
    if (needsBody && e.status === undefined && e.error === undefined && l.res.status >= 300)
      throw fail("успешный ответ", got(l.res));
    const items = Array.isArray(l.value) ? (l.value as unknown[]) : null;
    if (e.count !== undefined) {
      if (!items) throw fail("список", "не список");
      const c = e.count;
      const okCount =
        typeof c === "number"
          ? items.length === c
          : (c.gte === undefined || items.length >= c.gte) && (c.lte === undefined || items.length <= c.lte);
      if (!okCount) throw fail(`count=${JSON.stringify(c)}`, `${items.length}`);
    }
    const targets = items ?? [l.value];
    if (e.fields) {
      const want = resolve(e.fields) as Record<string, unknown>;
      for (const t of targets) {
        const obj = (t ?? {}) as Record<string, unknown>;
        for (const [k, w] of Object.entries(want)) {
          if (!sameValue(w, obj[k]))
            throw fail(`${k}=${show(k, w, deps.piiNames)}`, `${k}=${show(k, obj[k], deps.piiNames)}`);
        }
      }
    }
    for (const k of e.absentFields ?? []) {
      for (const t of targets) {
        if (t !== null && typeof t === "object" && Object.hasOwn(t, k))
          throw fail(`поля ${k} нет в ответе`, "поле есть");
      }
    }
    if (e.outbox) {
      const o = e.outbox;
      const names = new Set(
        (spec.integrations ?? [])
          .filter((i) => i.connector === o.connector || i.name === o.connector)
          .map((i) => i.name),
      );
      let msgs = env
        .outbox()
        .slice(outboxStart)
        .filter((m) => names.has(m.integration));
      if (o.to !== undefined) {
        const to = actors.get(o.to)?.id ?? resolve(o.to);
        msgs = msgs.filter((m) => m.userId === to);
      }
      if (o.containsFields)
        msgs = msgs.filter((m) =>
          o.containsFields?.every(
            (f) => m.payload !== null && typeof m.payload === "object" && Object.hasOwn(m.payload, f),
          ),
        );
      const okOut = o.count === undefined ? msgs.length > 0 : msgs.length === o.count;
      if (!okOut) throw fail(`сообщений ${o.connector}: ${o.count ?? "≥1"}`, `${msgs.length}`);
    }
  }

  const timed = async <T>(p: Promise<T>, n: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const budget = Math.min(stepTimeout, deadline - Date.now());
    if (budget <= 0) throw new StepError("fail", "Сценарий выполнялся дольше 20 с", `шаг ${n}`);
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new StepError(
                  "fail",
                  `Шаг ${n} выполнялся дольше ${Math.round(budget / 1000)} с`,
                  `шаг ${n}: таймаут`,
                ),
              ),
            budget,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    for (const [i, step] of sc.steps.entries()) {
      const n = i + 1;
      const action = actionOf(step);
      if (!action) throw new StepError("error", `Шаг ${n}: должно быть ровно одно действие`);
      if (action === "expect") {
        checkExpect(n, step.expect as Expect);
        checked = true;
        continue;
      }
      implicit();
      if (action === "as") {
        const a = step.as as NonNullable<Step["as"]>;
        if (typeof a === "string") {
          const actor = a === "anon" ? env.anonymous() : actors.get(a);
          if (!actor) throw new StepError("error", `Шаг ${n}: неизвестный участник «${a}»`);
          current = actor;
        } else {
          let actor = adhoc.get(a.role);
          if (!actor) {
            actor = await actorFor(a.role);
            adhoc.set(a.role, actor);
          }
          current = actor;
        }
        continue;
      }
      const r = await timed(act(step, action), n);
      last = { step: n, action, res: r.res, value: r.value };
      checked = false;
      const save = (step.create ?? step.read ?? step.update ?? step.callFn)?.save;
      if (save) vars.set(save, r.value);
    }
    implicit();
    return { status: "pass", message_ru: `Сценарий «${sc.title}» выполнен` };
  } catch (e) {
    if (e instanceof StepError) {
      return {
        status: e.status,
        message_ru:
          e.status === "error"
            ? `Не удалось проверить сценарий «${sc.title}»: ${e.message}`
            : `Сценарий «${sc.title}» не прошёл: ${e.message}`,
        ...(e.evidence ? { evidence: e.evidence } : {}),
      };
    }
    return {
      status: "error",
      message_ru: `Не удалось проверить сценарий «${sc.title}»: внутренняя ошибка`,
      evidence: String((e as Error)?.message ?? e),
    };
  }
}
