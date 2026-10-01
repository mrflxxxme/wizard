// Founder alerts of the platform (deploy.yaml#pilot.observability): a structured log line (level error/warn — the log
// pipeline turns it into an alert) plus the optional webhook WIZARD_OPS_ALERT_URL (e.g. the Telegram Bot API
// sendMessage URL with WIZARD_OPS_ALERT_CHAT_ID), the same channel infra/postgres/pg-ops.mjs uses.
import type { Logger } from "@wizard/pii/log";

export interface OpsAlert {
  level: "warn" | "error";
  /** Log event name (e.g. llm_monthly_cap_reached). */
  event: string;
  /** Russian text of the webhook message (no personal data). */
  text: string;
  /** Log fields (only the log allowlist survives: code, reason, count, kind…). */
  fields?: Record<string, string | number | null>;
}

export type OpsAlertFn = (a: OpsAlert) => Promise<void>;

export interface OpsAlertOptions {
  logger?: Pick<Logger, "warn" | "error">;
  webhook?: { url: string; chatId: string | null } | null;
  fetch?: typeof globalThis.fetch;
  /** Called when the webhook fails (the alert itself never throws). */
  onError?: (msg: string, err: unknown) => void;
}

/** Alert sender: never throws; the webhook gets {text, chat_id?} as JSON within 5 s. */
export function createOpsAlert(o: OpsAlertOptions): OpsAlertFn {
  const post = o.fetch ?? globalThis.fetch;
  return async (a) => {
    if (a.level === "error") o.logger?.error(a.event, undefined, a.fields);
    else o.logger?.warn(a.event, a.fields);
    if (!o.webhook) return;
    const body: Record<string, string> = { text: a.text };
    if (o.webhook.chatId) body.chat_id = o.webhook.chatId;
    try {
      const r = await post(o.webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) o.onError?.(`ops alert webhook answered ${r.status}`, null);
    } catch (e) {
      o.onError?.("ops alert webhook failed", e);
    }
  };
}
