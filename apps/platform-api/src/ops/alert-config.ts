// Founder alert channel from the platform config (M2-09): structured log line, WIZARD_OPS_ALERT_URL webhook and,
// with WIZARD_OPS_ALERT_EMAIL, a letter through the platform mailer (D21_beta_moderation «алерты в Telegram и на
// почту»). Used by platform-api, the worker and the publish workflow.
import { createLogger, type Logger } from "@wizard/pii/log";
import type { Mailer } from "../auth/mailer.js";
import { platformMailer } from "../auth/smtp-mailer.js";
import type { Config } from "../config.js";
import { createOpsAlert, type OpsAlertFn } from "./alert.js";

export function opsAlertFromConfig(
  config: Pick<Config, "opsAlert" | "opsAlertEmail" | "smtp" | "outboxDir">,
  o: { logger?: Logger; mailer?: Mailer; log?: (msg: string, err?: unknown) => void } = {},
): OpsAlertFn {
  const logger = o.logger ?? createLogger({ svc: "platform-api" });
  return createOpsAlert({
    logger,
    webhook: config.opsAlert,
    mail: config.opsAlertEmail
      ? { mailer: o.mailer ?? platformMailer(config), to: config.opsAlertEmail }
      : null,
    onError: (m, e) => (o.log ? o.log(m, e ?? undefined) : logger.error(m, e ?? undefined)),
  });
}
