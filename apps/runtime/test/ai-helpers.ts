// «helpdesk» test spec of the AI action tests (M3-02) and an in-process AI gateway over the fixture router: the same
// routeRuntimeAi the platform runs, on tools/fixtures/unit/runtime-ai.jsonl — no network, no platform.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, Workflow } from "@wizard/appspec";
import { createRouter, MemoryUsageSink, routeRuntimeAi } from "@wizard/llm";
import { WizardError } from "@wizard/sdk";
import type { AiGatewayClient, AiRunRequest, AiRunResponse } from "../src/index.js";
import { repoRoot } from "./helpers.js";

export const SCENARIOS = JSON.parse(
  readFileSync(join(repoRoot, "tools/fixtures/unit/runtime-ai.scenarios.json"), "utf8"),
) as {
  png: string;
  scenarios: { name: string; action: AiRunRequest["action"]; record: AiRunRequest["record"] }[];
};
export const scenario = (name: string) => {
  const s = SCENARIOS.scenarios.find((x) => x.name === name);
  if (!s) throw new Error(name);
  return s;
};
/** Bytes of the scenario PNG (photo_serial). */
export const PNG_BYTES = Buffer.from(SCENARIOS.png, "base64");

export const PAYMENT_TICKET = {
  title: "Не проходит оплата картой",
  body: "Третий день не могу оплатить заказ: банк отклоняет платёж.",
};
export const LOGIN_TICKET = {
  title: "Не могу войти в кабинет",
  body: "После обновления приложение не принимает код из письма.",
};

export function helpdeskSpec(workflows: Workflow[] = []): AppSpec {
  return {
    specVersion: "1",
    app: { name: "Поддержка", locale: "ru" },
    entities: [
      {
        name: "ticket",
        label: "Обращение",
        fields: [
          { name: "title", label: "Тема", type: "string", required: true, maxLength: 200 },
          { name: "body", label: "Описание", type: "text" },
          {
            name: "category",
            label: "Категория",
            type: "enum",
            enum: [
              { value: "billing", label: "Оплата" },
              { value: "tech", label: "Техника" },
              { value: "other", label: "Другое" },
            ],
          },
          { name: "priority", label: "Срочность", type: "int", min: 1, max: 5 },
          { name: "reply", label: "Ответ клиенту", type: "text", maxLength: 2000 },
          { name: "photo", label: "Фото", type: "file", pii: "none" },
          { name: "serial", label: "Серийный номер", type: "string", maxLength: 40 },
          { name: "is_public", label: "На публичной доске", type: "bool" },
        ],
      },
    ],
    roles: [
      { name: "guest", label: "Гость", access: "public" },
      { name: "agent", label: "Оператор", access: "login", loginMethods: ["email_otp"] },
      { name: "viewer", label: "Наблюдатель", access: "login", loginMethods: ["email_otp"] },
    ],
    permissions: [
      { role: "guest", entity: "ticket", ops: ["read", "update"], rowFilter: { is_public: true } },
      { role: "agent", entity: "ticket", ops: ["read", "create", "update"] },
      { role: "viewer", entity: "ticket", ops: ["read"] },
    ],
    workflows,
    integrations: [],
    functions: [],
    pages: [],
    aiActions: [
      {
        name: "classify_ticket",
        kind: "extract",
        input: {
          entity: "ticket",
          fields: ["title", "body"],
          instruction: "Определи категорию обращения и срочность от 1 до 5",
        },
        output: { fields: ["category", "priority"] },
        monthlyLimit: 50,
        tier: "T0",
      },
      {
        name: "draft_reply",
        kind: "generate",
        input: {
          entity: "ticket",
          fields: ["title", "body"],
          instruction: "Напиши вежливый короткий ответ клиенту",
        },
        output: { field: "reply" },
        monthlyLimit: 50,
      },
      {
        name: "read_photo",
        kind: "extract",
        input: {
          entity: "ticket",
          fields: ["title", "photo"],
          instruction: "Прочитай серийный номер устройства на фото",
        },
        output: { fields: ["serial"] },
        monthlyLimit: 50,
      },
    ],
    acceptance: [],
  } as AppSpec;
}

export interface TestGateway extends AiGatewayClient {
  calls: AiRunRequest[];
  /** Next answers override: an error code instead of the fixture answer. */
  failWith: string | null;
}

/** The platform gateway's model step in-process: fixture router, T0 only, no limits or credits. */
export function fixtureGateway(): TestGateway {
  const router = createRouter({
    mode: "fixture",
    env: {},
    fixture: { suite: "unit", name: "runtime-ai" },
    sink: new MemoryUsageSink(),
  });
  const g: TestGateway = {
    calls: [],
    failWith: null,
    async run(req): Promise<AiRunResponse> {
      g.calls.push(req);
      if (g.failWith) throw new WizardError(g.failWith);
      const out = await routeRuntimeAi(router, {
        action: req.action,
        record: req.record,
        ...(req.attachments ? { attachments: req.attachments } : {}),
        ctx: { orgId: "00000000-0000-4000-8000-0000000000d1" },
      });
      return {
        values: out.values,
        skipped: out.skipped,
        tier: "T0",
        model: out.model,
        creditsMilli: out.creditsMilli,
      };
    },
  };
  return g;
}
