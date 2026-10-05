// Platform mail over SMTP (M2-09; compliance.yaml#subprocessors «Почтовый провайдер (РФ)», E-ACCESS): OTP codes,
// org invites, owner notices, billing letters, pilot invitations and founder alerts. Reuses the connectors' minimal
// SMTP client and MIME builder (implicit TLS on 465 or mandatory STARTTLS on 587; plaintext only for a local
// receiver outside production) — no new dependency. Without WIZARD_SMTP_HOST letters go to the outbox files as
// before. DKIM/SPF/DMARC of the sender domain are DNS records at the provider (docs/ops/mail.md). With
// WIZARD_MAIL_TRANSPORT=unisender-api (default for a *.unisender.ru host) letters go over the Unisender Go HTTP API
// on 443 instead (ApiMailer, email.yaml#transport): the pilot's server has the mail ports closed.
import { randomUUID } from "node:crypto";
import {
  buildMessage,
  type Dialer,
  formatAddress,
  headerSafe,
  isPlainAddress,
  SmtpError,
  sendSmtp,
  sendUnisenderApi,
  UNISENDER_DEFAULT_BASE,
} from "@wizard/connectors";
import type { Config, PlatformSmtp } from "../config.js";
import { type Mailer, type MailMessage, OutboxMailer } from "./mailer.js";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain HTML twin of the text (no external images, no tracking), as the systems' platform mail. */
function htmlOf(text: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328"><div style="max-width:560px;margin:0 auto;padding:16px">${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div></body></html>`;
}

export interface SmtpMailerOptions {
  /** Extra trusted CA (tests against a local receiver). */
  ca?: string;
  dial?: Dialer;
  timeoutMs?: number;
  /** Pause before the single retry of a transient failure (connection, TLS, 4xx); default 2 s. */
  retryDelayMs?: number;
  /** HTTP transport of ApiMailer (tests substitute it). */
  fetch?: typeof fetch;
}

/** Transient: connection/TLS/timeouts (code 0) and 4xx replies; 5xx (bad recipient, auth) are final. */
const transient = (e: unknown) => e instanceof SmtpError && (e.code === 0 || (e.code >= 400 && e.code < 500));

export class SmtpMailer implements Mailer {
  constructor(
    readonly smtp: PlatformSmtp,
    private readonly o: SmtpMailerOptions = {},
  ) {}

  /** The RFC 5322 message of a letter (exported for tests). */
  compose(m: MailMessage, now = new Date()): string {
    if (!isPlainAddress(m.to)) throw new Error("invalid recipient address");
    const domain = this.smtp.from.address.split("@")[1] ?? "wizard.local";
    return buildMessage({
      headers: [
        ["Subject", headerSafe(m.subject)],
        ["Date", now.toUTCString()],
        ["Message-ID", `<${randomUUID()}@${domain}>`],
        ["Auto-Submitted", "auto-generated"],
        ["X-Wizard-Kind", m.kind],
      ],
      addressHeaders: [
        ["From", formatAddress(this.smtp.from.address, this.smtp.from.name || undefined)],
        ["To", formatAddress(m.to)],
      ],
      text: m.text,
      html: htmlOf(m.text),
    });
  }

  async send(m: MailMessage): Promise<void> {
    const data = this.compose(m);
    const attempt = () =>
      sendSmtp({
        endpoint: {
          host: this.smtp.host,
          port: this.smtp.port,
          tls: this.smtp.tls,
          ...(this.smtp.user ? { user: this.smtp.user } : {}),
        },
        ...(this.smtp.password ? { password: this.smtp.password } : {}),
        from: this.smtp.from.address,
        to: [m.to],
        data,
        ehloName: this.smtp.from.address.split("@")[1] ?? "wizard.local",
        timeoutMs: this.o.timeoutMs ?? 15_000,
        ...(this.o.ca ? { ca: this.o.ca } : {}),
        ...(this.o.dial ? { dial: this.o.dial } : {}),
      });
    try {
      await attempt();
    } catch (e) {
      if (!transient(e)) throw e;
      await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? 2000));
      await attempt();
    }
  }
}

/**
 * Platform mail over the Unisender Go HTTP API (POST email/send.json, X-API-KEY = the SMTP password). Same letter as
 * SmtpMailer: subject, text and its HTML twin, the sender with its name, X-Wizard-Kind. 429/5xx/network are retried
 * once, other 4xx are final (MailApiError, an SmtpError with an SMTP-equivalent code).
 */
export class ApiMailer implements Mailer {
  constructor(
    readonly smtp: PlatformSmtp,
    private readonly o: SmtpMailerOptions = {},
  ) {}

  async send(m: MailMessage): Promise<void> {
    if (!isPlainAddress(m.to)) throw new Error("invalid recipient address");
    await sendUnisenderApi(
      {
        from: this.smtp.from.address,
        ...(this.smtp.from.name ? { fromName: this.smtp.from.name } : {}),
        to: m.to,
        subject: headerSafe(m.subject),
        text: m.text,
        html: htmlOf(m.text),
        headers: { "X-Wizard-Kind": m.kind },
      },
      {
        base: this.smtp.apiBase ?? UNISENDER_DEFAULT_BASE,
        apiKey: this.smtp.password ?? "",
        timeoutMs: this.o.timeoutMs ?? 15_000,
        retryDelayMs: this.o.retryDelayMs ?? 2000,
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      },
    );
  }
}

/**
 * The platform's mailer from the config: the Unisender Go API or SMTP when WIZARD_SMTP_HOST is set, else the outbox
 * files.
 */
export function platformMailer(
  config: Pick<Config, "smtp" | "outboxDir">,
  o: SmtpMailerOptions = {},
): Mailer {
  if (!config.smtp) return new OutboxMailer(config.outboxDir);
  return config.smtp.transport === "unisender-api"
    ? new ApiMailer(config.smtp, o)
    : new SmtpMailer(config.smtp, o);
}
