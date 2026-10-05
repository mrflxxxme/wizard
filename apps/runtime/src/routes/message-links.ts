// One-time links of visitor messages (M2-50, D69): /_wizard/hooks/message/<cancel|unsubscribe>/<token>. The token is
// sealed by the runtime (AES-GCM, auth keys) and bound to the deployment; no login. GET shows a confirmation page with
// a button (mail scanners prefetch links, so GET changes nothing), POST applies once: cancel writes the step's
// `cancel.set` into the record, unsubscribe clears the step's consent field. Path segments after the action are
// masked in logs like connector hook tokens.
import { createHash } from "node:crypto";
import { quoteIdent, type Workflow } from "@wizard/appspec";
import { Hono } from "hono";
import type { AuthKeys } from "../auth/keys.js";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { type MessageLinkPayload, messageLinkAad } from "../preview/connectors.js";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function html(status: number, title: string, text: string, form?: { button: string }): Response {
  const action = form
    ? `<form method="post"><button type="submit">${escapeHtml(form.button)}</button></form>`
    : "";
  const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${action}</main></body></html>`;
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
  unsubscribeAsk: ["Отписаться от писем?", "Вы перестанете получать письма по этой записи."],
  unsubscribeButton: "Отписаться",
  unsubscribeDone: ["Вы отписались", "Письма по этой записи больше не придут."],
} as const;

const invalid = () => html(404, TEXT.invalid[0], TEXT.invalid[1]);

type Action = MessageLinkPayload["a"];
const isAction = (a: string): a is Action => a === "cancel" || a === "unsubscribe";

/** The notify step the link was issued by, with its consent field and cancel values (from the current spec). */
function stepOf(c: RuntimeContext, p: MessageLinkPayload) {
  const w = (c.get("system").spec.workflows ?? []).find((x: Workflow) => x.name === p.wf);
  const st = w?.steps[p.st];
  if (st?.type !== "notify") return null;
  const params = (st.params ?? {}) as Record<string, unknown>;
  const set = (params.cancel as { set?: unknown } | undefined)?.set;
  return {
    consentField: typeof params.consentField === "string" ? params.consentField : null,
    cancelSet:
      typeof set === "object" && set !== null && !Array.isArray(set)
        ? (set as Record<string, unknown>)
        : null,
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

export function messageLinkRoutes(keys: AuthKeys): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  app.get("/:action/:token", (c) => {
    const link = open(c, keys);
    const step = link ? stepOf(c, link.p) : null;
    if (!link || !step) return invalid();
    if (link.p.a === "cancel") {
      if (!step.cancelSet) return invalid();
      return html(200, TEXT.cancelAsk[0], TEXT.cancelAsk[1], { button: TEXT.cancelButton });
    }
    if (!step.consentField) return invalid();
    return html(200, TEXT.unsubscribeAsk[0], TEXT.unsubscribeAsk[1], { button: TEXT.unsubscribeButton });
  });

  app.post("/:action/:token", async (c) => {
    const link = open(c, keys);
    const step = link ? stepOf(c, link.p) : null;
    if (!link || !step) return invalid();
    const { p } = link;
    const patch: Record<string, unknown> | null =
      p.a === "cancel" ? step.cancelSet : step.consentField ? { [step.consentField]: false } : null;
    if (!patch) return invalid();
    const sys = c.get("system");
    const marker = `link:${createHash("sha256").update(link.token).digest("hex")}`;
    // One transaction: the one-time marker and the change commit together (a failed change leaves the link usable).
    const done = await sys.data.transaction("write", SYSTEM_SUBJECT, async (d) => {
      const used = await d.sql.unsafe(
        `insert into ${quoteIdent(sys.schema)}."_w_connector_calls"
           (idempotency_key, integration, action, status) values ($1, '_messages', $2, 'used')
         on conflict (idempotency_key) do nothing`,
        [marker, p.a],
      );
      if (used.count === 0) return false;
      const row = await d.system.get(p.en, p.id);
      if (!row) return false;
      await d.system.patch(p.en, p.id, patch);
      return true;
    });
    if (!done) return invalid();
    const [title, text] = p.a === "cancel" ? TEXT.cancelDone : TEXT.unsubscribeDone;
    return html(200, title, text);
  });

  app.all("*", () => invalid());
  return app;
}
