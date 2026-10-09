// The agent side of the key window (V3-21; D77_v3 (15)): the request_secret tool — the model names the key, the
// recipient domain and the purpose, the platform opens its own window in the chat and the model gets back only
// secret://<name>; the build hook that asks for the keys of integrations still on the mock; and the D37 check that a
// function never sends a window key to a host the owner did not see in the window.
import type { LlmTool } from "@wizard/llm";
import type postgres from "postgres";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { latestContracts } from "../integrations-v3/store.js";
import { requestSecret, SECRET_WINDOW_NAME } from "./service.js";
import { listBindings, secretRefExists, systemOrg, withOrg } from "./store.js";

/** The tool of agents (packages/llm LlmTool): the answer carries secret://<name>, never a value. */
export const REQUEST_SECRET_TOOL: LlmTool = {
  name: "request_secret",
  description:
    "Попросить владельца ввести ключ доступа к внешнему API в защищённом окне чата. Окно показывает домен получателя и назначение; ключ шифруется в браузере. В ответ — только ссылка secret://name: значение ключа модель не видит никогда. Никогда не проси ключ обычным сообщением.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "domain", "purpose"],
    properties: {
      name: { type: "string", pattern: SECRET_WINDOW_NAME.source, description: "Имя ключа: secret://<name>" },
      domain: {
        type: "string",
        maxLength: 253,
        description: "Домен API, куда уйдёт ключ (например api.yookassa.ru)",
      },
      purpose: { type: "string", maxLength: 300, description: "Зачем ключ — по-русски, для владельца" },
      integrationId: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$", description: "Интеграция брифа" },
    },
  },
};

const toolArgs = z.strictObject({
  name: z.string(),
  domain: z.string().max(253),
  purpose: z.string().max(300),
  integrationId: z.string().optional(),
});

export interface RequestSecretToolResult {
  secretRef: string;
  status: "window_opened" | "already_set" | "rejected";
  message_ru: string;
  windowId?: string;
}

/** Runs request_secret for a system (the build or interview host); refusals come back as a result, not a throw. */
export async function runRequestSecret(
  deps: { pg: postgres.Sql; platformDomains?: readonly string[] },
  ctx: { systemId: string; runId?: string | null },
  args: unknown,
): Promise<RequestSecretToolResult> {
  const a = toolArgs.safeParse(args);
  const name = a.success ? a.data.name : "";
  const secretRef = `secret://${SECRET_WINDOW_NAME.test(name) ? name : "invalid"}`;
  if (!a.success)
    return { secretRef, status: "rejected", message_ru: "Нужны имя ключа, домен получателя и назначение" };
  if (await secretRefExists(deps.pg, ctx.systemId, name, "draft"))
    return {
      secretRef,
      status: "already_set",
      message_ru: `Ключ ${secretRef} уже введён — используйте ссылку`,
    };
  try {
    const r = await requestSecret(deps, {
      systemId: ctx.systemId,
      name,
      domain: a.data.domain,
      purpose: a.data.purpose,
      integrationId: a.data.integrationId ?? null,
      requestedBy: "agent",
      runId: ctx.runId ?? null,
    });
    return {
      secretRef,
      status: "window_opened",
      windowId: r.window.id,
      message_ru: `Окно ключа открыто в чате: ключ уйдёт только на ${r.window.hosts.join(", ")}. Пока ключа нет, интеграция работает на моке`,
    };
  } catch (e) {
    if (e instanceof ApiError) return { secretRef, status: "rejected", message_ru: e.message_ru };
    throw e;
  }
}

/**
 * The build agent asks for the keys its integrations need: every latest contract with a key, still on the mock (or
 * failed) and without a value, gets a window (an open one is kept). Returns the windows opened now.
 */
export async function requestMissingKeys(
  deps: { pg: postgres.Sql; platformDomains?: readonly string[] },
  ctx: { systemId: string; runId?: string | null },
): Promise<string[]> {
  const opened: string[] = [];
  for (const row of await latestContracts(deps.pg, ctx.systemId)) {
    const c = row.contract;
    if (!c.auth.secret || row.status === "live") continue;
    const name = c.auth.secret.slice("secret://".length);
    if (!SECRET_WINDOW_NAME.test(name) || (await secretRefExists(deps.pg, ctx.systemId, name))) continue;
    const r = await requestSecret(deps, {
      systemId: ctx.systemId,
      name,
      purpose: `Подключить «${c.name}» к системе: без ключа сборка работает на моке`.slice(0, 300),
      integrationId: c.id,
      requestedBy: "agent",
      runId: ctx.runId ?? null,
    });
    if (r.created) opened.push(r.window.id);
  }
  return opened;
}

export interface SecretEgressIssue {
  /** JSON Pointer into the spec. */
  path: string;
  message_ru: string;
}

type SpecFunctions = { functions?: { name: string; egress?: string[]; secretRefs?: string[] }[] };

/**
 * D37 for window keys: a function that uses secret://<name> of a window may reach only the hosts that window showed
 * (the union over draft and prod bindings of the name). Keys set without a window are not judged here.
 */
export function secretEgressIssues(
  spec: SpecFunctions,
  bindings: readonly { name: string; hosts: readonly string[] }[],
): SecretEgressIssue[] {
  const allowed = new Map<string, Set<string>>();
  for (const b of bindings) {
    const s = allowed.get(b.name) ?? new Set<string>();
    for (const h of b.hosts) s.add(h.toLowerCase());
    allowed.set(b.name, s);
  }
  const out: SecretEgressIssue[] = [];
  (spec.functions ?? []).forEach((f, i) => {
    for (const r of f.secretRefs ?? []) {
      const hosts = allowed.get(r.slice("secret://".length));
      if (!hosts) continue;
      (f.egress ?? []).forEach((h, j) => {
        if (!hosts.has(h.toLowerCase()))
          out.push({
            path: `/functions/${i}/egress/${j}`,
            message_ru: `Функция «${f.name}» отправила бы ключ ${r} на ${h}, а в окне ключа владелец видел только ${[...hosts].join(", ")}`,
          });
      });
    }
  });
  return out;
}

/**
 * V3Host.integrations with the key window (builds-v3/host.ts): after the integrations layer the spec must keep window
 * keys within their hosts (else the build stops, like a widened contract egress), and the agent opens windows for the
 * keys still missing. Asking for keys never fails a build.
 */
export function withKeyWindow<I, R extends { spec: SpecFunctions } | null>(
  hook: (input: I) => Promise<R>,
  o: { pg: postgres.Sql; systemId: string; runId?: string | null; log?: (m: string, e?: unknown) => void },
): (input: I) => Promise<R> {
  return async (input) => {
    const out = await hook(input);
    if (out) {
      const sys = await systemOrg(o.pg, o.systemId);
      const bindings = sys ? await withOrg(o.pg, sys.orgId, (tx) => listBindings(tx, o.systemId)) : [];
      const issues = secretEgressIssues(out.spec, bindings);
      if (issues.length) throw new Error(`secret egress: ${issues.map((i) => i.message_ru).join("; ")}`);
      await requestMissingKeys({ pg: o.pg }, { systemId: o.systemId, runId: o.runId ?? null }).catch((e) =>
        o.log?.("key window request failed", e),
      );
    }
    return out;
  };
}
