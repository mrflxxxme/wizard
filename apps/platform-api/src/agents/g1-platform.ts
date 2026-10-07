// B2-28: connector platform of the G1 runtime. G1 systems are drafts: e-mail, Telegram and SMS land in the runtime
// outbox (test mode), nothing leaves the process. The sender needs a real-looking domain — with the systems domain of
// the G1 runtime («localhost») noreply@localhost is not an address and login codes and invitations fail.
import { type PlatformConnectorConfig, staticSecretReader } from "@wizard/connectors";

/** Sender domain of G1 letters when WIZARD_MAIL_DOMAIN is not set (they never leave the outbox). */
export const G1_MAIL_DOMAIN = "systems.test";

const offline = async (): Promise<never> => {
  throw new Error("G1 runtime has no network");
};

export function g1PlatformConfig(env: Readonly<Record<string, string | undefined>>): PlatformConnectorConfig {
  return {
    // No platform secrets: a G1 connector that would need one fails like an unconfigured platform.
    secrets: staticSecretReader({}),
    telegram: {
      apiBase: "https://api.telegram.org",
      botUsername: env.WIZARD_TELEGRAM_BOT_USERNAME || "wizard_g1_bot",
    },
    smtp: null,
    mailApi: null,
    devSmtp: null,
    mailDomain: env.WIZARD_MAIL_DOMAIN?.trim() || G1_MAIL_DOMAIN,
    resolve: offline,
    dial: offline,
  };
}
