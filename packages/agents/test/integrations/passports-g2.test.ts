// V3-22: G2-TG-01 (no ПДн to Telegram) sees the Telegram Bot API passport — the generated client in both modes (its
// HOSTS), callers through ctx.scheduler, workflow «function» steps and direct imports; getMe, setWebhook and messages
// without ПДн pass, a chat id is an address, not content.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSpec } from "@wizard/appspec";
import { type GateContext, runG2 } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import {
  contractHash,
  integrationCode,
  passportById,
  passportContract,
} from "../../src/integrations/index.js";

const ROOT = join(fileURLToPath(import.meta.url), "../../../../..");
const forum = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;

const tgPassport = passportById("telegram");
if (!tgPassport) throw new Error("telegram");
const contract = passportContract(tgPassport, { id: "bot", name: "Бот клуба" });

const caller = (body: string) => `import { action, v } from "@wizard/sdk";

export default action({
  args: { ticketId: v.string() },
  handler: async (ctx, args) => {
    const ticket = { holder_phone: "x", holder_name: "y", id: args.ticketId };
${body}
    return null;
  },
});
`;

async function tg01(mode: "mock" | "live", o: { body?: string; workflowText?: string }): Promise<string[]> {
  const code = integrationCode(contract, mode, `contract://bot@1#${contractHash(contract).slice(0, 12)}`);
  const files = new Map(Object.entries(code.files));
  const functions = [...(forum.functions ?? []), ...code.functions];
  if (o.body !== undefined) {
    files.set("functions/notifyBot.ts", caller(o.body));
    functions.push({ name: "notifyBot", kind: "action", file: "functions/notifyBot.ts" });
  }
  const workflows = [...(forum.workflows ?? [])];
  if (o.workflowText !== undefined)
    workflows.push({
      name: "bot_ticket",
      trigger: { type: "on_create", entity: "ticket" },
      steps: [
        {
          type: "function",
          params: { name: "botSendMessage", args: { body: { chat_id: "1", text: o.workflowText } } },
        },
      ],
    });
  const spec = { ...forum, functions, workflows } as AppSpec;
  const ctx = {
    spec,
    prevSpec: null,
    specVersion: 1,
    files,
    env: "draft",
    systemKey: "g2tg",
  } as unknown as GateContext;
  const r = await runG2(ctx, { only: ["G2-TG-01"] });
  return r.checks
    .filter((c) => c.id === "G2-TG-01" && c.status !== "pass")
    .map((c) => `${c.message_ru} ${c.evidence ?? ""}`);
}

describe("G2-TG-01 over the Telegram passport", () => {
  test.each(["mock", "live"] as const)(
    "%s: a phone of the record through ctx.scheduler → blocker",
    async (mode) => {
      const found = await tg01(mode, {
        body: [
          '    await ctx.scheduler.runAfter(0, "botSendMessage", {',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: generated function source
          '      body: { chat_id: "1", text: `Билет оформлен, телефон ${ticket.holder_phone}` },',
          "    });",
        ].join("\n"),
      });
      expect(found.join("\n")).toMatch(/Telegram персональные данные.*holder_phone/);
    },
  );

  test("a workflow «function» step with a ПДн field of the record → blocker", async () => {
    const found = await tg01("live", { workflowText: "Новый билет: $record.holder_name" });
    expect(found.join("\n")).toMatch(/Шаг воркфлоу.*holder_name/);
  });

  test("getMe, setWebhook and a message without ПДн pass; the chat id is an address", async () => {
    const body = [
      '    await ctx.scheduler.runAfter(0, "botGetMe", {});',
      '    await ctx.scheduler.runAfter(0, "botSetWebhook", {',
      '      body: { url: "https://forum.example.com/hooks/bot", secret_token: "hook" },',
      "    });",
      '    await ctx.scheduler.runAfter(0, "botSendMessage", {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated function source
      "      body: { chat_id: ticket.holder_phone, text: `Билет ${ticket.id} оформлен — откройте систему` },",
      "    });",
    ].join("\n");
    expect(await tg01("mock", { body })).toEqual([]);
    expect(await tg01("live", { body, workflowText: "Новый билет — откройте систему" })).toEqual([]);
  });
});
