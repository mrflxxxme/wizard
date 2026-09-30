// Platform-owned connector settings from the process environment (platform/deploy.yaml#local.env_vars M1 list;
// names beyond it are listed in docs/reviews/impl-notes/M1-06.md).
import { systemResolver, tcpDialer } from "./net.js";
import { missingSecret } from "./secrets.js";
import type { SmtpEndpoint } from "./smtp.js";
import { TELEGRAM_API_BASE } from "./telegram-api.js";
import type { PlatformConnectorConfig } from "./types.js";

type EnvSource = Readonly<Record<string, string | undefined>>;

const PLATFORM_SECRET_VARS: Readonly<Record<string, string>> = {
  telegram_bot_token: "WIZARD_TELEGRAM_BOT_TOKEN",
  telegram_webhook_secret: "WIZARD_TELEGRAM_WEBHOOK_SECRET",
  smtp_password: "WIZARD_SMTP_PASSWORD",
};

export interface PlatformEnvOptions {
  /** Default sender domain (WIZARD_SYSTEMS_DOMAIN). */
  systemsDomain: string;
  /** Local modes allow the dev SMTP receiver (WIZARD_DEV_SMTP=1). */
  local: boolean;
}

/**
 * WIZARD_TELEGRAM_BOT_TOKEN / _WEBHOOK_SECRET / _BOT_USERNAME / _API_BASE, WIZARD_SMTP_HOST / _PORT / _USER /
 * _PASSWORD, WIZARD_MAIL_DOMAIN, WIZARD_DEV_SMTP(_PORT). Secret values are read at call time, never cached here.
 */
export function platformConfigFromEnv(env: EnvSource, o: PlatformEnvOptions): PlatformConnectorConfig {
  const port = Number(env.WIZARD_SMTP_PORT ?? 465);
  const smtp: SmtpEndpoint | null = env.WIZARD_SMTP_HOST
    ? {
        host: env.WIZARD_SMTP_HOST,
        port,
        tls: port === 465 ? "implicit" : "starttls",
        ...(env.WIZARD_SMTP_USER ? { user: env.WIZARD_SMTP_USER } : {}),
      }
    : null;
  return {
    secrets: {
      async get(name) {
        const v = PLATFORM_SECRET_VARS[name] ? env[PLATFORM_SECRET_VARS[name] as string] : undefined;
        if (!v) throw missingSecret(name);
        return v;
      },
    },
    telegram: {
      apiBase: env.WIZARD_TELEGRAM_API_BASE || TELEGRAM_API_BASE,
      botUsername: env.WIZARD_TELEGRAM_BOT_USERNAME || null,
    },
    smtp,
    devSmtp:
      o.local && env.WIZARD_DEV_SMTP === "1"
        ? { host: "127.0.0.1", port: Number(env.WIZARD_DEV_SMTP_PORT ?? 1025), tls: "none" }
        : null,
    mailDomain: env.WIZARD_MAIL_DOMAIN || o.systemsDomain,
    resolve: systemResolver,
    dial: tcpDialer,
  };
}
