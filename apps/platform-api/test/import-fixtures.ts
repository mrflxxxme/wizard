// Shared fixtures of the import tests (platform-api imports.test.ts, worker import kill test): the client spec, a mock
// OpenAI-compatible provider answering import_mapping from the payload it got, and the scripted builder.
import { join } from "node:path";
import { type AppSpec, validateSpec } from "@wizard/appspec";
import type { BuildHost, BuildParams } from "../src/runs/types.js";
import { ROOT } from "./helpers.js";

export const ENV = {
  ZAI_BASE_URL: "http://mock.local/zai",
  ZAI_API_KEY: "k",
  CLOUDRU_BASE_URL: "http://mock.local/cloudru",
  CLOUDRU_API_KEY: "k",
};
export const SHEET = "Клиенты Рахимова"; // a lone surname in the genitive: must not reach T1 as the sheet name

export function clientSpec(): AppSpec {
  const r = validateSpec({
    specVersion: "1",
    app: { name: "Клиенты", locale: "ru" },
    entities: [
      {
        name: "client",
        label: "Клиент",
        fields: [
          { name: "full_name", label: "ФИО", type: "string", required: true, pii: "basic", piiKind: "fio" },
          { name: "phone", label: "Телефон", type: "phone", pii: "basic", piiKind: "phone" },
          { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
          { name: "city", label: "Город", type: "string" },
          { name: "total", label: "Сумма", type: "money" },
          { name: "note", label: "Комментарий", type: "text", pii: "basic", piiKind: "free_text" },
        ],
      },
    ],
    roles: [{ name: "manager", label: "Менеджер", access: "login", loginMethods: ["email_otp"] }],
    permissions: [{ role: "manager", entity: "client", ops: ["read", "create", "update", "delete"] }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

export const TARGET: Record<string, [string, string]> = {
  "ФИО клиента": ["map", "full_name"],
  Телефон: ["map", "phone"],
  Почта: ["map", "email"],
  Город: ["map", "city"],
  "Сумма заказа": ["map", "total"],
  Комментарий: ["map", "note"],
  Источник: ["new_field", "source"],
};

export interface Req {
  provider: "zai" | "cloudru";
  body: string;
}

/** OpenAI-compatible mock: import_mapping answers from the payload it received; other calls get plain text. */
export function mockProviders() {
  const requests: Req[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const provider = String(url).includes("/zai") ? "zai" : "cloudru";
    const body = String(init?.body ?? "");
    requests.push({ provider, body });
    const req = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
    let message: Record<string, unknown> = { role: "assistant", content: "Готово" };
    if (body.includes("propose_mapping")) {
      const user = req.messages.find((m) => m.role === "user")?.content ?? "{}";
      const { table } = JSON.parse(user) as {
        table: { sheets: { name: string; columns: { header: string }[] }[] };
      };
      const mappings = table.sheets.flatMap((s) =>
        s.columns.map((c) => {
          const t = TARGET[c.header];
          return t
            ? { sheet: s.name, column: c.header, action: t[0], entity: "client", field: t[1] }
            : { sheet: s.name, column: c.header, action: "skip" };
        }),
      );
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "propose_mapping", arguments: JSON.stringify({ mappings }) },
          },
        ],
      };
    }
    return new Response(
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: req.model,
        choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export type SpecToOps = {
  specToOps(spec: unknown, o: { author: string }): unknown[];
  batchOps(ops: unknown[]): unknown[][];
};

/** create: the client spec; change (import schema_ops): add_field for card.importFields after a build_ops call. */
export async function importBuild(host: BuildHost, p: BuildParams, cards: Record<string, unknown>[]) {
  if (p.mode === "create") {
    const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as SpecToOps;
    for (const [i, ops] of lib.batchOps(lib.specToOps(clientSpec(), { author: "agent" })).entries()) {
      const { version } = await host.store.getSpec();
      const r = await host.store.applyOps(ops, version, `${host.run.id}:ops_${i}`);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
    }
  } else {
    cards.push(p.card);
    await host.route({
      callType: "build_ops",
      messages: [{ role: "user", content: JSON.stringify(p.card) }],
      step: "ops",
    });
    const fields = (p.card.importFields ?? []) as {
      entity: string;
      field: string;
      label: string;
      type: string;
    }[];
    const ops = fields.map((f) => ({
      op: "add_field",
      entity: f.entity,
      field: { name: f.field, label: f.label, type: f.type },
    }));
    const { version } = await host.store.getSpec();
    const r = await host.store.applyOps(ops, version, `${host.run.id}:import_ops`);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
  }
  await host.store.writeFile("ui/Home.tsx", "export default function Home() { return null; }\n");
  const report = await host.runGates("G0");
  if (!report.passed) throw new Error("G0");
  return { summary_ru: "Готово" };
}
