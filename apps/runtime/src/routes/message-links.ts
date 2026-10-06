// One-time links of visitor messages (M2-50, D69): /_wizard/hooks/message/<cancel|unsubscribe|reschedule>/<token>.
// The token is sealed by the runtime (AES-GCM, auth keys) and bound to the deployment; no login. GET shows a
// confirmation page with a button (mail scanners prefetch links, so GET changes nothing), POST applies once: cancel
// writes the step's `cancel.set` into the record, unsubscribe clears the step's consent field. B2-14: reschedule — GET
// redirects to the step's `reschedule.page` with the token and the `keep` values in the query (the system's page
// offers free times); the page links back here with new values of `reschedule.fields` in the query, GET confirms and
// POST applies them once; a unique index conflict leaves the link usable. `cancel.until` / `reschedule.until` close a
// link `minutesBefore` the record's date field. Path segments after the action are masked in logs like connector hook
// tokens, query strings are never logged.
import { createHash } from "node:crypto";
import { type Entity, quoteIdent, type Workflow } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type { AuthKeys } from "../auth/keys.js";
import { type DataTx, SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { DEFAULT_TIMEZONE } from "../jobs/cron.js";
import { MESSAGE_LINK_PATH, type MessageLinkPayload, messageLinkAad } from "../preview/connectors.js";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function html(
  status: number,
  title: string,
  text: string,
  extra: { button?: string; link?: { href: string; label: string } } = {},
): Response {
  const action = extra.button
    ? `<form method="post"><button type="submit">${escapeHtml(extra.button)}</button></form>`
    : "";
  const link = extra.link
    ? `<p><a href="${escapeHtml(extra.link.href)}">${escapeHtml(extra.link.label)}</a></p>`
    : "";
  const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${action}${link}</main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

const TEXT = {
  invalid: ["Ссылка недействительна", "Ссылка устарела или уже использована."],
  cancelAsk: ["Отменить запись?", "Запись будет отменена. Это действие нельзя отменить по ссылке."],
  cancelButton: "Отменить запись",
  cancelDone: ["Запись отменена", "Спасибо, что предупредили."],
  cancelLate: [
    "Отменить по ссылке уже нельзя",
    "До начала осталось меньше времени, чем можно для отмены по ссылке. Пожалуйста, свяжитесь с нами.",
  ],
  unsubscribeAsk: ["Отписаться от писем?", "Вы перестанете получать письма по этой записи."],
  unsubscribeButton: "Отписаться",
  unsubscribeDone: ["Вы отписались", "Письма по этой записи больше не придут."],
  rescheduleClosed: [
    "Перенести по ссылке уже нельзя",
    "Запись уже отменена, прошла или до начала осталось слишком мало времени. Пожалуйста, свяжитесь с нами.",
  ],
  rescheduleAsk: ["Перенести запись?", "Запись будет перенесена на выбранное время."],
  rescheduleButton: "Перенести",
  rescheduleEmpty: ["Выберите новое время", "Новое время не выбрано."],
  rescheduleTaken: ["Это время уже занято", "Пока вы выбирали, это время заняли. Выберите другое."],
  rescheduleInvalid: ["Не получилось перенести", "Проверьте выбранное время и попробуйте ещё раз."],
  rescheduleBack: "Выбрать другое время",
  rescheduleDone: ["Запись перенесена", "Новое время сохранено. Ждём вас!"],
} as const;

const invalid = () => html(404, TEXT.invalid[0], TEXT.invalid[1]);

type Action = MessageLinkPayload["a"];
const isAction = (a: string): a is Action => a === "cancel" || a === "unsubscribe" || a === "reschedule";
type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

interface Until {
  field: string;
  minutesBefore: number;
}
interface Reschedule {
  page: string;
  fields: string[];
  keep: string[];
  set: Row;
  until: Until | null;
  when: Row | null;
}

function untilOf(v: unknown): Until | null {
  if (!isObj(v) || typeof v.field !== "string" || typeof v.minutesBefore !== "number") return null;
  return { field: v.field, minutesBefore: v.minutesBefore };
}

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function rescheduleOf(v: unknown): Reschedule | null {
  if (!isObj(v) || typeof v.page !== "string" || !/^\/[a-z0-9/_-]*$/.test(v.page)) return null;
  const fields = names(v.fields);
  if (!fields.length) return null;
  return {
    page: v.page,
    fields,
    keep: names(v.keep),
    set: isObj(v.set) ? v.set : {},
    until: untilOf(v.until),
    when: isObj(v.when) ? v.when : null,
  };
}

/** The notify step the link was issued by (from the current spec): consent field, cancel and reschedule rules. */
function stepOf(c: RuntimeContext, p: MessageLinkPayload) {
  const spec = c.get("system").spec;
  const w = (spec.workflows ?? []).find((x: Workflow) => x.name === p.wf);
  const st = w?.steps[p.st];
  if (st?.type !== "notify") return null;
  const params = (st.params ?? {}) as Row;
  const cancel = isObj(params.cancel) ? params.cancel : null;
  return {
    entity: spec.entities.find((e: Entity) => e.name === p.en),
    consentField: typeof params.consentField === "string" ? params.consentField : null,
    cancelSet: cancel && isObj(cancel.set) ? cancel.set : null,
    cancelUntil: untilOf(cancel?.until),
    reschedule: rescheduleOf(params.reschedule),
  };
}

function open(c: RuntimeContext, keys: AuthKeys): { p: MessageLinkPayload; token: string } | null {
  const action = c.req.param("action") ?? "";
  const token = c.req.param("token") ?? "";
  if (!isAction(action)) return null;
  const { entry } = c.get("system");
  const p = keys.unseal<MessageLinkPayload>(token, messageLinkAad(entry.systemId, entry.env));
  if (!p || p.a !== action || typeof p.exp !== "number" || p.exp < c.get("services").clock().getTime())
    return null;
  if (
    typeof p.en !== "string" ||
    typeof p.id !== "string" ||
    typeof p.wf !== "string" ||
    typeof p.st !== "number"
  )
    return null;
  return { p, token };
}

const timeOf = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number.NaN;

/** The link is closed `minutesBefore` the record's date field (a record without the value stays open). */
function tooLate(until: Until | null, row: Row, now: Date): boolean {
  if (!until) return false;
  const at = timeOf(row[until.field]);
  return Number.isFinite(at) && now.getTime() > at - until.minutesBefore * 60_000;
}

/** `{field: value | [values]}` against the record (as notify steps' `if`). */
function matches(when: Row | null, row: Row): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, allowed]) =>
    (Array.isArray(allowed) ? allowed : [allowed]).some((a) => String(a) === String(row[k])),
  );
}

async function readRow(c: RuntimeContext, p: MessageLinkPayload): Promise<Row | null> {
  const sys = c.get("system");
  return sys.data.transaction(
    "default",
    SYSTEM_SUBJECT,
    (d) => d.system.get(p.en, p.id) as Promise<Row | null>,
  );
}

/**
 * New values of the allowed fields: from the query string (the system's page links to the confirmation with them;
 * generated pages may not post forms elsewhere, G0-SEC-01), else from a form or JSON body. Numbers and flags by type.
 */
async function rescheduleValues(
  c: RuntimeContext,
  r: Reschedule,
  entity: Entity | undefined,
  withBody: boolean,
): Promise<Row> {
  let body: Row = {};
  const query = c.req.query();
  if (r.fields.some((f) => query[f] !== undefined)) body = query;
  else if (withBody) {
    const type = c.req.header("content-type") ?? "";
    try {
      body = type.includes("application/json")
        ? ((await c.req.json()) as Row)
        : ((await c.req.parseBody()) as Row);
    } catch {
      return {};
    }
  }
  if (!isObj(body)) return {};
  const out: Row = {};
  for (const name of r.fields) {
    const raw = body[name];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
    const t = entity?.fields.find((f) => f.name === name)?.type;
    if ((t === "int" || t === "decimal" || t === "money") && typeof raw === "string") {
      const n = Number(raw);
      out[name] = Number.isFinite(n) ? n : raw;
    } else if (t === "bool" && typeof raw === "string") out[name] = raw === "true";
    else out[name] = raw;
  }
  return out;
}

export function messageLinkRoutes(keys: AuthKeys): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  const now = (c: RuntimeContext) => c.get("services").clock();

  app.get("/:action/:token", async (c) => {
    const link = open(c, keys);
    const step = link ? stepOf(c, link.p) : null;
    if (!link || !step) return invalid();
    const { p } = link;
    if (p.a === "unsubscribe") {
      if (!step.consentField) return invalid();
      return html(200, TEXT.unsubscribeAsk[0], TEXT.unsubscribeAsk[1], { button: TEXT.unsubscribeButton });
    }
    const r = p.a === "reschedule" ? step.reschedule : null;
    if (p.a === "cancel" ? !step.cancelSet : !r) return invalid();
    const row = await readRow(c, p);
    if (!row) return invalid();
    if (p.a === "cancel") {
      if (tooLate(step.cancelUntil, row, now(c))) return html(410, TEXT.cancelLate[0], TEXT.cancelLate[1]);
      return html(200, TEXT.cancelAsk[0], TEXT.cancelAsk[1], { button: TEXT.cancelButton });
    }
    if (!r || !matches(r.when, row) || tooLate(r.until, row, now(c)))
      return html(410, TEXT.rescheduleClosed[0], TEXT.rescheduleClosed[1]);
    const values = await rescheduleValues(c, r, step.entity, false);
    if (Object.keys(values).length > 0) {
      // The page chose a new time: confirm it (the button posts to this same URL with the values in the query).
      const at = r.fields.find((f) => step.entity?.fields.find((x) => x.name === f)?.type === "datetime");
      const when = at ? timeOf(values[at]) : Number.NaN;
      const tz = c.get("system").spec.app.timezone ?? DEFAULT_TIMEZONE;
      const text = Number.isFinite(when)
        ? `Новое время: ${new Intl.DateTimeFormat("ru-RU", { timeZone: tz, dateStyle: "long", timeStyle: "short" }).format(when)}.`
        : TEXT.rescheduleAsk[1];
      return html(200, TEXT.rescheduleAsk[0], text, {
        button: TEXT.rescheduleButton,
        link: { href: `${MESSAGE_LINK_PATH}/reschedule/${link.token}`, label: TEXT.rescheduleBack },
      });
    }
    // The token and non-PII values go in the query string: runtime logs never carry it (runtime.yaml#logging.rules).
    const q = new URLSearchParams({ reschedule: link.token });
    for (const k of r.keep) {
      const v = row[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") q.set(k, String(v));
    }
    return new Response(null, {
      status: 303,
      headers: { location: `${r.page}?${q}`, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  });

  app.post("/:action/:token", async (c) => {
    const link = open(c, keys);
    const step = link ? stepOf(c, link.p) : null;
    if (!link || !step) return invalid();
    const { p } = link;
    const sys = c.get("system");
    const marker = `link:${createHash("sha256").update(link.token).digest("hex")}`;
    const useOnce = async (d: DataTx) => {
      const used = await d.sql.unsafe(
        `insert into ${quoteIdent(sys.schema)}."_w_connector_calls"
           (idempotency_key, integration, action, status) values ($1, '_messages', $2, 'used')
         on conflict (idempotency_key) do nothing`,
        [marker, p.a],
      );
      return used.count > 0;
    };

    if (p.a === "reschedule") {
      const r = step.reschedule;
      if (!r) return invalid();
      const back = { href: `${MESSAGE_LINK_PATH}/reschedule/${link.token}`, label: TEXT.rescheduleBack };
      const values = await rescheduleValues(c, r, step.entity, true);
      let outcome: "done" | "used" | "closed" | "empty";
      try {
        // One transaction: a conflict or a bad value rolls the one-time marker back, so the link stays usable.
        outcome = await sys.data.transaction("write", SYSTEM_SUBJECT, async (d) => {
          const row = (await d.system.get(p.en, p.id)) as Row | null;
          if (!row) return "used";
          if (!matches(r.when, row) || tooLate(r.until, row, now(c))) return "closed";
          if (Object.keys(values).length === 0) return "empty";
          if (!(await useOnce(d))) return "used";
          await d.system.patch(p.en, p.id, { ...values, ...r.set });
          return "done";
        });
      } catch (e) {
        if (e instanceof WizardError && e.code === "CONFLICT")
          return html(409, TEXT.rescheduleTaken[0], TEXT.rescheduleTaken[1], { link: back });
        if (e instanceof WizardError && e.code === "VALIDATION_FAILED")
          return html(400, TEXT.rescheduleInvalid[0], TEXT.rescheduleInvalid[1], { link: back });
        throw e;
      }
      if (outcome === "closed") return html(410, TEXT.rescheduleClosed[0], TEXT.rescheduleClosed[1]);
      if (outcome === "empty")
        return html(400, TEXT.rescheduleEmpty[0], TEXT.rescheduleEmpty[1], { link: back });
      if (outcome === "used") return invalid();
      return html(200, TEXT.rescheduleDone[0], TEXT.rescheduleDone[1]);
    }

    const patch: Row | null =
      p.a === "cancel" ? step.cancelSet : step.consentField ? { [step.consentField]: false } : null;
    if (!patch) return invalid();
    // One transaction: the one-time marker and the change commit together (a failed change leaves the link usable).
    const done = await sys.data.transaction("write", SYSTEM_SUBJECT, async (d) => {
      const row = (await d.system.get(p.en, p.id)) as Row | null;
      if (!row) return "used";
      if (p.a === "cancel" && tooLate(step.cancelUntil, row, now(c))) return "late";
      if (!(await useOnce(d))) return "used";
      await d.system.patch(p.en, p.id, patch);
      return "done";
    });
    if (done === "late") return html(410, TEXT.cancelLate[0], TEXT.cancelLate[1]);
    if (done !== "done") return invalid();
    const [title, text] = p.a === "cancel" ? TEXT.cancelDone : TEXT.unsubscribeDone;
    return html(200, title, text);
  });

  app.all("*", () => invalid());
  return app;
}
