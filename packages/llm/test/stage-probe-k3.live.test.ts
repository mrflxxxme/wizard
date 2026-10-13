// V4-06 live probe: does Kimi K3 take `thinking: {type: "disabled"}` with tools, and what does it save? The same page
// task (a first screen as TSX through a tool) twice per mode, straight to the Moonshot API; prints time, output and
// reasoning tokens (never the key). Skipped unless WIZARD_STAGE_PROBE names «k3»: it runs only in GitHub Actions.
import { describe, expect, test } from "vitest";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("k3");
const BASE = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";

const tool = {
  type: "function",
  function: {
    name: "submit_page",
    description: "Код первого экрана",
    parameters: {
      type: "object",
      properties: {
        tsx: { type: "string", description: "TSX компонента Hero, 30–60 строк, Tailwind на токенах темы" },
      },
      required: ["tsx"],
    },
  },
};
const messages = [
  {
    role: "system",
    content:
      "Ты пишешь первый экран сайта на React 19 + Tailwind. Только классы темы (bg-background, text-foreground, bg-primary, font-display, text-hero). Один export default function. Ответ — вызов submit_page.",
  },
  {
    role: "user",
    content:
      "Стоматология «Белая линия» в Казани: лечение без боли, запись онлайн, администратор перезвонит за 15 минут. Первый экран с фото кабинета и кнопкой «Записаться».",
  },
];

describe.skipIf(!ON)("Kimi K3: thinking on and off", () => {
  test(
    "two calls per mode",
    async () => {
      const rows: string[] = [];
      for (const mode of ["default", "disabled"] as const)
        for (let i = 0; i < 2; i++) {
          const t0 = Date.now();
          const res = await fetch(`${BASE}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${process.env.KIMI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "kimi-k3",
              temperature: mode === "disabled" ? 0.6 : 1,
              max_tokens: 16000,
              messages,
              tools: [tool],
              tool_choice: "auto",
              ...(mode === "disabled" ? { thinking: { type: "disabled" } } : {}),
            }),
          });
          const ms = Date.now() - t0;
          const body = (await res.json().catch(() => ({}))) as {
            usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
            choices?: { message?: { tool_calls?: unknown[]; reasoning_content?: string } }[];
            error?: { message?: string };
          };
          const msg = body.choices?.[0]?.message;
          const row = {
            mode,
            status: res.status,
            ms,
            output: body.usage?.completion_tokens,
            reasoning:
              body.usage?.completion_tokens_details?.reasoning_tokens ?? msg?.reasoning_content?.length ?? 0,
            tool: Boolean(msg?.tool_calls?.length),
            error: body.error?.message?.slice(0, 200),
          };
          console.log(`k3_probe=${JSON.stringify(row)}`);
          rows.push(
            `| ${mode} | ${row.status} | ${ms} | ${row.output} | ${row.reasoning} | ${row.tool} | ${row.error ?? ""} |`,
          );
        }
      const summary = `## Kimi K3: размышления\n\n| Режим | HTTP | мс | Выход | Размышления | Инструмент | Ошибка |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(rows).toHaveLength(4);
    },
    15 * 60_000,
  );
});
