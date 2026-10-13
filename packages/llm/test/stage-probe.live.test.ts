// V4-05 live stage probe (plan v4 §5.2, D79 (10)): every new model of the v4 route answers 2–3 Russian inputs of its own
// stage through the real gateway (createRouter, live mode, platform keys from env). Skipped unless WIZARD_STAGE_PROBE=1:
// it runs only in GitHub Actions (.github/workflows/stage-probe-a.yml), never in CI or locally. Prints one record per
// call (answer, usage, ₽, ms; never keys) to the log and to tools/llm-probe/out/stage-probe-a.jsonl.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  type CallType,
  createRegistry,
  createRouter,
  type LlmMessage,
  type LlmTool,
  MemoryUsageSink,
  type Registry,
} from "../src/index.js";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("llm");
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);
const OPEN = { ruOnly: false, t1Restricted: false };

/** One model only, no reserve: a failure is the model's own answer, not a fallback. */
function only(ct: CallType, model: string): Registry {
  const base = createRegistry({ buildDefaultTier: "T1" });
  return { ...base, routes: { ...base.routes, [ct]: { ...base.routes[ct], chain: { T1: [model] } } } };
}

const BRIEFS = [
  "Пекарня «Колос» в Твери: хлеб на закваске, торты на заказ, доставка по городу. Владелец хочет тёплый сайт с заказом торта.",
  "Стоматология «Белая линия» в Казани: лечение, имплантация, детский приём. Нужна онлайн-запись к врачу.",
  "Автосервис «Гараж 42» в Екатеринбурге: ремонт подвески, шиномонтаж, диагностика. Заявка на ремонт с сайта.",
];

const designTool: LlmTool = {
  name: "submit_design",
  description: "Дизайн-система сайта",
  parameters: {
    type: "object",
    properties: {
      palette: { type: "array", items: { type: "string" }, description: "3–5 цветов в hex" },
      fonts: {
        type: "array",
        items: { type: "string" },
        description: "≤ 2 семейства шрифтов с лицензией OFL",
      },
      mood: { type: "string", description: "Настроение по-русски, одно предложение" },
    },
    required: ["palette", "fonts", "mood"],
  },
};
const pageTool: LlmTool = {
  name: "submit_page",
  description: "Код первого экрана",
  parameters: {
    type: "object",
    properties: { tsx: { type: "string", description: "TSX компонента Hero, до 40 строк" } },
    required: ["tsx"],
  },
};
const reviewTool: LlmTool = {
  name: "submit_review",
  description: "Итог ревью",
  parameters: {
    type: "object",
    properties: {
      findings: { type: "array", items: { type: "string" }, description: "Замечания по-русски" },
      ok: { type: "boolean" },
    },
    required: ["findings", "ok"],
  },
};

/** A w×h PNG of horizontal bands (a «screenshot» of a page: header, hero, button) for the vision models. */
function bandsPng(w: number, h: number, bands: [number, number, number][]): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (table[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const [r, g, b] = bands[Math.min(bands.length - 1, Math.floor((y / h) * bands.length))] as [
      number,
      number,
      number,
    ];
    rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([r, g, b]))]));
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

interface Probe {
  id: string;
  callType: CallType;
  model: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
}

const sys = (s: string): LlmMessage => ({ role: "system", content: s });
const PROBES: Probe[] = [
  // Art director: Kimi K3 (head) and GLM-5.3 (reserve) on the same briefs.
  ...["kimi-k3", "glm-5.3"].flatMap((model) =>
    BRIEFS.slice(0, 2).map(
      (b, i): Probe => ({
        id: `art_direction:${model}:${i + 1}`,
        callType: "art_direction",
        model,
        tools: [designTool],
        messages: [
          sys(
            "Ты арт-директор. Предложи дизайн-систему сайта: 3–5 цветов, не больше 2 семейств шрифтов из каталога OFL, без фиолетовых градиентов. Ответь вызовом submit_design.",
          ),
          { role: "user", content: b },
        ],
      }),
    ),
  ),
  // Page code: Kimi K3 and DeepSeek V4-Pro (reserve; empty balance on 13.10.2026).
  ...["kimi-k3", "deepseek-v4-pro-0813"].flatMap((model) =>
    BRIEFS.slice(0, 2).map(
      (b, i): Probe => ({
        id: `page_compose:${model}:${i + 1}`,
        callType: "page_compose",
        model,
        tools: [pageTool],
        messages: [
          sys(
            "Ты пишешь первый экран сайта на React 19 + Tailwind (классы на токенах bg-surface, text-ink, bg-accent). Тексты по-русски, только факты из брифа, без эмодзи. До 40 строк. Ответь вызовом submit_page.",
          ),
          { role: "user", content: b },
        ],
      }),
    ),
  ),
  // Visual critic and judge: GLM-5V-Turbo (head) and Kimi K3 (sees images) on two «screenshots».
  ...["glm-5v-turbo", "kimi-k3"].flatMap((model) =>
    [
      bandsPng(390, 844, [
        [250, 246, 240],
        [181, 84, 27],
        [250, 246, 240],
      ]),
      bandsPng(720, 450, [
        [20, 20, 20],
        [40, 40, 40],
        [60, 60, 60],
      ]),
    ].map(
      (png, i): Probe => ({
        id: `critic_visual:${model}:${i + 1}`,
        callType: "critic_visual",
        model,
        messages: [
          sys(
            "Ты визуальный критик сайтов. Отвечай по-русски, коротко: оценка 0–100 и одно главное замечание.",
          ),
          {
            role: "user",
            content: `Снимок первого экрана ${i === 0 ? "390" : "1440"}. Хватает ли контраста и есть ли акцент?`,
            attachments: [{ mime: "image/png", data: png }],
          },
        ],
      }),
    ),
  ),
  // Techreview: MiMo V2.6 Pro (empty balance on 13.10.2026). Mass edits: DeepSeek V4.1 Flash, MiMo Flash, GLM-5.3-Flash.
  ...BRIEFS.slice(0, 2).map(
    (b, i): Probe => ({
      id: `techreview:mimo-v2.6-pro:${i + 1}`,
      callType: "techreview",
      model: "mimo-v2.6-pro",
      tools: [reviewTool],
      messages: [
        sys("Ты ревьюер. Найди проблемы в функции и ответь вызовом submit_review."),
        {
          role: "user",
          content: `Система: ${b}\nФункция: export async function createLead(input) { await db.insert("leads", input); return { ok: true }; }`,
        },
      ],
    }),
  ),
  ...["deepseek-v4.1-flash", "mimo-v2.6-flash", "glm-5.3-flash"].flatMap((model) =>
    BRIEFS.slice(0, 2).map(
      (b, i): Probe => ({
        id: `page_edit:${model}:${i + 1}`,
        callType: "page_edit",
        model,
        tools: [pageTool],
        messages: [
          sys("Ты правишь код страницы. Верни исправленный TSX вызовом submit_page."),
          {
            role: "user",
            content: `${b}\nЗамени заголовок на «Запишитесь онлайн» в коде: export function Hero() { return <h1 className="text-ink">Добро пожаловать</h1>; }`,
          },
        ],
      }),
    ),
  ),
];

describe.skipIf(!ON)("V4-05 live stage probe", () => {
  test(
    "every new model of the v4 route answers its stage in Russian",
    async () => {
      const records: Record<string, unknown>[] = [];
      for (const p of PROBES) {
        const sink = new MemoryUsageSink();
        const router = createRouter({ mode: "live", registry: only(p.callType, p.model), sink });
        const t0 = Date.now();
        try {
          const out = await router.route({
            callType: p.callType,
            messages: p.messages,
            ...(p.tools ? { tools: p.tools, toolChoice: "required" as const } : {}),
            orgPolicy: OPEN,
            ctx: { orgId: "00000000-0000-4000-8000-0000000000f5", step: `stage_probe_a:${p.id}` },
          });
          records.push({
            id: p.id,
            status: "ok",
            model: out.model,
            ms: Date.now() - t0,
            rub: sink.records.reduce((s, r) => s + r.costRub, 0),
            usage: out.usage,
            finish: out.result.finishReason,
            text: out.result.text?.slice(0, 1500) ?? null,
            toolCalls: out.result.toolCalls.map((c) => ({ name: c.name, args: c.args })),
          });
        } catch (e) {
          const err = e as { code?: string; message?: string; details?: unknown };
          records.push({
            id: p.id,
            status: "error",
            code: err.code ?? "ERROR",
            attempts: sink.records.map((r) => `${r.modelId}:${r.status}:${r.errorCode ?? ""}`),
            ms: Date.now() - t0,
          });
        }
        console.log(`stage_probe=${JSON.stringify(records.at(-1))}`);
      }
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        new URL("stage-probe-a.jsonl", OUT),
        `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      );
      const rub = records.reduce((s, r) => s + Number(r.rub ?? 0), 0);
      const table = records.map(
        (r) =>
          `| ${r.id} | ${r.status === "ok" ? "✅" : `❌ ${r.code}`} | ${r.ms} | ${Number(r.rub ?? 0).toFixed(3)} | ${
            r.status === "ok"
              ? String(JSON.stringify(r.toolCalls).slice(0, 160) || r.text).replace(/\|/g, "\\|")
              : String(r.attempts)
          } |`,
      );
      const summary = `## Живая проба этапов V4-05\n\nИтого ${rub.toFixed(2)} ₽\n\n| Проба | Статус | мс | ₽ | Ответ |\n|---|---|---|---|---|\n${table.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(records.length).toBe(PROBES.length);
    },
    30 * 60_000,
  );
});
