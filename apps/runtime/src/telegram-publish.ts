// Own-bot management at publication (connectors/telegram.yaml#bot_api: getMe checks the token, setWebhook points
// the bot at /_wizard/hooks/telegram/<integration>/<hookToken> of the prod host). The shared platform bot has one
// platform webhook and is skipped. Called by platform-api's publish workflow (FU-6).
import type { AppSpec } from "@wizard/appspec";
import {
  outboxMessage,
  type PlatformConnectorConfig,
  telegramBot,
  telegramConfigSchema,
  telegramGetMe,
  telegramSetWebhook,
} from "@wizard/connectors";
import type { DataAccess } from "./data/access.js";
import { type RuntimeEnv, readEnv } from "./env.js";
import type { OutboxMessage } from "./http/context.js";
import { createConnectorHost, type SecretsFactory } from "./preview/connectors.js";
import type { SystemEnv } from "./registry.js";

export interface TelegramPublishOptions {
  /** live — Bot API calls; outbox — the calls are only recorded (local stands, tests without a Bot API). */
  mode: "live" | "outbox";
  /** Scheme and systems domain of the prod host; default readEnv(process.env). */
  env?: Partial<RuntimeEnv>;
  /** Bot API base and platform secrets; default platformConfigFromEnv(process.env). */
  platform?: PlatformConnectorConfig;
  /** Integration secrets; default `.env` WIZARD_SECRET_<SYSTEMID>_<NAME>. */
  secrets?: SecretsFactory;
  /** outbox mode: also append to <outboxDir>/<systemKey>/telegram.jsonl. */
  outboxDir?: string | null;
  /** outbox mode: recorded calls (as runtime outbox messages). */
  outbox?: OutboxMessage[];
  log?: (line: Record<string, unknown>) => void;
}

export interface TelegramPublishSystem {
  systemKey: string;
  slug: string;
  env?: SystemEnv;
  revision: number;
  spec: AppSpec;
}

export interface TelegramBotResult {
  integration: string;
  /** getMe username (live) or the configured botUsername (outbox). */
  username: string | null;
  status: "webhook_set" | "recorded";
}

/** getMe/setWebhook never touch system data: any access is a bug. */
const NO_DATA = new Proxy({} as DataAccess, {
  get() {
    throw new Error("publishTelegramBots: system data is not available");
  },
});

/** getMe + setWebhook for every own-bot Telegram integration; ConnectorError on a bad token or Bot API failure. */
export async function publishTelegramBots(
  o: TelegramPublishOptions,
  s: TelegramPublishSystem,
): Promise<TelegramBotResult[]> {
  const own = (s.spec.integrations ?? []).filter(
    (i) => i.connector === "telegram" && telegramBot(telegramConfigSchema.parse(i.config ?? {})) === "own",
  );
  if (own.length === 0) return [];
  const env: RuntimeEnv = { ...readEnv(), ...o.env };
  const outbox = o.outbox ?? [];
  const host = createConnectorHost({
    env,
    clock: () => new Date(),
    outbox,
    devSecretsDir: o.outboxDir ?? "",
    outboxDir: o.outboxDir ?? null,
    ...(o.platform ? { platform: o.platform } : {}),
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  const entry = {
    systemId: s.systemKey,
    slug: s.slug,
    env: s.env ?? "prod",
    revision: s.revision,
    specHash: "",
    bundleKey: "",
    publishedAt: new Date().toISOString(),
    suspended: false,
    features: { phoneOtp: false },
  };
  const out: TelegramBotResult[] = [];
  for (const integ of own) {
    const ctx = host.ctx({ entry, spec: s.spec, data: NO_DATA }, integ);
    if (o.mode === "outbox") {
      const config = ctx.integration.config as { botUsername?: string };
      for (const action of ["getMe", "setWebhook"])
        await ctx.outbox.write(
          outboxMessage({ ...ctx, idempotencyKey: `publish:${s.revision}:${action}` }, "telegram", action, {
            host: ctx.system.host,
          }),
        );
      out.push({ integration: integ.name, username: config.botUsername ?? null, status: "recorded" });
      continue;
    }
    const me = await telegramGetMe(ctx);
    await telegramSetWebhook(ctx);
    out.push({ integration: integ.name, username: me.username ?? null, status: "webhook_set" });
  }
  return out;
}
