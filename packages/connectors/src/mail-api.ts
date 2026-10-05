// Mail over the Unisender Go HTTP API (specs/connectors/email.yaml#transport): the pilot's server has the outgoing
// mail ports (25, 465, 587, 2525) closed, so platform mail leaves over 443. The SMTP password of Unisender Go is the
// API key itself — no new secret. Errors reuse SmtpError with an SMTP-equivalent code, so the callers' transient /
// final split and the ConnectorError mapping stay the same as for SMTP. The key and the letter never reach an error.
import type { InlineImage } from "./mime.js";
import { SmtpError } from "./smtp.js";

type EnvSource = Readonly<Record<string, string | undefined>>;

/** How platform mail leaves: SMTP submission or the Unisender Go HTTP API (443). */
export type MailTransport = "smtp" | "unisender-api";
export const MAIL_TRANSPORTS: readonly MailTransport[] = ["smtp", "unisender-api"];
export const UNISENDER_API_TIMEOUT_MS = 15_000;
export const UNISENDER_DEFAULT_BASE = "https://goapi.unisender.ru";
const SEND_PATH = "/ru/transactional/api/v1/email/send.json";

const isUnisenderHost = (host: string) => /(^|\.)unisender\.ru$/i.test(host.trim().replace(/\.$/, ""));

/**
 * WIZARD_MAIL_TRANSPORT (smtp | unisender-api); unset — unisender-api for a *.unisender.ru SMTP host, else smtp.
 * null — an unknown value (platform-api refuses to start).
 */
export function mailTransportOf(env: EnvSource): MailTransport | null {
  const v = (env.WIZARD_MAIL_TRANSPORT ?? "").trim().toLowerCase();
  if (v) return (MAIL_TRANSPORTS as readonly string[]).includes(v) ? (v as MailTransport) : null;
  return isUnisenderHost(env.WIZARD_SMTP_HOST ?? "") ? "unisender-api" : "smtp";
}

/** API origin: WIZARD_MAIL_API_BASE, else smtp.goN.unisender.ru → https://goN.unisender.ru, else goapi. */
export function unisenderApiBase(smtpHost: string | undefined, override?: string): string {
  const o = (override ?? "").trim().replace(/\/+$/, "");
  if (o) return o;
  const m = /^smtp\.(go\d+)\.unisender\.ru\.?$/i.exec((smtpHost ?? "").trim());
  return m ? `https://${(m[1] as string).toLowerCase()}.unisender.ru` : UNISENDER_DEFAULT_BASE;
}

/** The API transport of the platform mail from WIZARD_* env; null — SMTP (or no mail configured). */
export function mailApiFromEnv(env: EnvSource): { base: string } | null {
  if (!env.WIZARD_SMTP_HOST?.trim() || mailTransportOf(env) !== "unisender-api") return null;
  return { base: unisenderApiBase(env.WIZARD_SMTP_HOST, env.WIZARD_MAIL_API_BASE) };
}

export interface ApiAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** A structured letter: one recipient, text + HTML, inline images by cid, attachments, X- headers. */
export interface ApiMail {
  from: string;
  fromName?: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  inline?: readonly InlineImage[];
  attachments?: readonly ApiAttachment[];
  /** Only X-… headers are passed (the API ignores others). */
  headers?: Readonly<Record<string, string>>;
}

export interface UnisenderSendOptions {
  /** API origin, e.g. https://go1.unisender.ru. */
  base: string;
  /** X-API-KEY (the Unisender Go SMTP password). */
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries of a transient failure (network, timeout, 429, 5xx); default 1. */
  retries?: number;
  /** Pause before a retry; default 2 s. */
  retryDelayMs?: number;
}

/** HTTP failure of the API; `code` is the SMTP equivalent (0 network, 451 transient, 535 auth, 550 recipient, 554). */
export class MailApiError extends SmtpError {
  /** HTTP status; 0 — network failure or timeout. */
  readonly httpStatus: number;
  /** Unisender API error code from the body, when present. */
  readonly apiCode: number | null;
  /** The provider's explanation (addresses masked, ≤160 chars) — the codes are not documented publicly. */
  readonly apiMessage: string | null;
  constructor(httpStatus: number, apiCode: number | null, apiMessage: string | null = null) {
    super(smtpEquivalent(httpStatus, apiCode), "api");
    this.name = "MailApiError";
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
    this.apiMessage = apiMessage
      ? apiMessage.replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "<почта>").slice(0, 160)
      : null;
    this.message = `mail api failed${httpStatus ? ` (HTTP ${httpStatus}${apiCode !== null ? `, code ${apiCode}` : ""})` : ""}${this.apiMessage ? `: ${this.apiMessage}` : ""}`;
  }
  /** 429, 5xx and network failures are transient; other 4xx are final. */
  get transient(): boolean {
    return this.httpStatus === 0 || this.httpStatus === 429 || this.httpStatus >= 500;
  }
}

function smtpEquivalent(status: number, apiCode: number | null): number {
  if (status === 0) return 0;
  if (status === 429 || status >= 500) return 451;
  if (status === 401 || status === 403) return 535;
  // 204: every recipient is invalid, unsubscribed or unavailable (failed_emails).
  if (apiCode === 204) return 550;
  return 554;
}

const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");

/** The email/send.json request body (exported for tests). No tracking options: see email.yaml#transport. */
export function unisenderBody(m: ApiMail): unknown {
  const headers = Object.fromEntries(
    Object.entries(m.headers ?? {}).filter(([k]) => /^X-[A-Za-z0-9-]+$/i.test(k)),
  );
  return {
    message: {
      recipients: [{ email: m.to }],
      subject: m.subject,
      from_email: m.from,
      ...(m.fromName ? { from_name: m.fromName } : {}),
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      // The text is already rendered: no {{…}} substitutions of the provider.
      template_engine: "none",
      body: { plaintext: m.text, html: m.html },
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(m.attachments?.length
        ? {
            attachments: m.attachments.map((a) => ({
              type: a.contentType,
              name: a.filename.replace(/\//g, "_"),
              content: b64(a.data),
            })),
          }
        : {}),
      ...(m.inline?.length
        ? {
            inline_attachments: m.inline.map((a) => ({
              type: a.contentType,
              name: a.cid,
              content: b64(a.data),
            })),
          }
        : {}),
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
  o: Pick<UnisenderSendOptions, "apiKey" | "fetch" | "timeoutMs">,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": o.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? UNISENDER_API_TIMEOUT_MS),
    });
  } catch {
    throw new MailApiError(0, null);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || json?.status !== "success") {
    const code = typeof json?.code === "number" ? json.code : null;
    const message = typeof json?.message === "string" ? json.message : null;
    // A 200 without "success" is unexpected: treat as a server fault (transient).
    throw new MailApiError(res.ok ? 502 : res.status, code, message);
  }
  return json;
}

/** POST email/send.json with one retry of a transient failure; returns the provider's job_id. */
export async function sendUnisenderApi(mail: ApiMail, o: UnisenderSendOptions): Promise<{ jobId: string }> {
  const url = `${o.base.replace(/\/+$/, "")}${SEND_PATH}`;
  const body = unisenderBody(mail);
  let left = o.retries ?? 1;
  for (;;) {
    try {
      const json = await postJson(url, body, o);
      return { jobId: typeof json.job_id === "string" ? json.job_id : "" };
    } catch (e) {
      if (!(e instanceof MailApiError) || !e.transient || left <= 0) throw e;
      left -= 1;
      await new Promise((r) => setTimeout(r, o.retryDelayMs ?? 2000));
    }
  }
}
