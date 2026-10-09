// V3-11: test material of the build harness v3, built by code. A clinic brief with «must» and «should» scenarios
// (moduleHint where a catalog module closes them), recorded answers of the art director and of the page composer
// (suite demo — answers by the order of each callType; usage from the real prompt estimate, so the cost is the
// models.yaml price) written to a temporary fixture dir, and a fake page composer of the V3-12 seam (contract.ts): its
// skeleton is plain code, a scenario is one or more page_compose calls through ctx.route.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BriefScenario, SystemBriefInput } from "@wizard/appspec";
import type { FixtureLine, LlmMessage } from "@wizard/llm";
import { z } from "zod";
import {
  artDirectionCandidates,
  artDirectionMessages,
  artDirectionSchema,
  type PageComposer,
  pageFile,
  type V3BuildContext,
  type V3ComposeResult,
} from "../src/builder/index.js";
import { defineTool } from "../src/core/tool.js";
import { fixtureLine, serializeLines } from "./build-v2-fixtures.js";

type ScenarioInput = Omit<BriefScenario, "then" | "priority"> & { priority?: BriefScenario["priority"] };

function scenario(s: ScenarioInput, steps: string[]): NonNullable<SystemBriefInput["scenarios"]>[number] {
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
  return { ...s, then: steps };
}

/** Scenario ids of the clinic brief in build order («must» first). */
export const CLINIC_MUST = ["s_book", "s_lead", "s_prices", "s_remind"] as const;
export const CLINIC_SHOULD = ["s_doctors", "s_report"] as const;

/**
 * A dental clinic: booking, a lead form, prices, reminders (must); doctors and a weekly report (should). archetype —
 * the direction the owner chose (V3-09); null — none, the art director picks. roles — the brief names the staff.
 */
export function clinicBrief(o: { archetype?: string | null; roles?: boolean } = {}): SystemBriefInput {
  const archetype = o.archetype === undefined ? "calm_medical" : o.archetype;
  return {
    goals: [
      { id: "g_book", text: "Записи на приём с сайта", success: "Не меньше 30 записей в месяц" },
      { id: "g_leads", text: "Заявки на консультацию", success: "10 заявок в неделю" },
    ],
    audience: "Жители района 25–55 лет, записываются с телефона вечером",
    scenarios: [
      scenario({ id: "s_doctors", actor: "visitor", when: "посетитель выбирает врача", priority: "should" }, [
        "показывает врачей и их специализацию",
      ]),
      scenario(
        {
          id: "s_book",
          actor: "visitor",
          when: "посетитель выбирает услугу и время",
          goalId: "g_book",
          moduleHint: "booking",
        },
        ["создаёт запись", "показывает подтверждение"],
      ),
      scenario(
        {
          id: "s_lead",
          actor: "visitor",
          when: "посетитель оставляет заявку на консультацию",
          goalId: "g_leads",
          moduleHint: "leads",
        },
        ["сохраняет заявку", "уведомляет администратора"],
      ),
      scenario(
        { id: "s_prices", actor: "visitor", when: "посетитель смотрит услуги и цены", moduleHint: "catalog" },
        ["показывает услуги с ценами"],
      ),
      scenario({ id: "s_remind", actor: "system", when: "до приёма остаётся сутки", moduleHint: "notify" }, [
        "напоминает клиенту о записи",
      ]),
      scenario(
        {
          id: "s_report",
          actor: "owner",
          when: "владелец открывает отчёт за неделю",
          priority: "should",
          moduleHint: "reports",
        },
        ["показывает записи и заявки по дням"],
      ),
    ],
    roles: o.roles
      ? [
          { id: "admin", name: "Администратор", can: ["подтверждает записи", "обрабатывает заявки"] },
          { id: "doctor", name: "Врач", can: ["видит свои записи"] },
        ]
      : [],
    data: [
      {
        entity: "Запись",
        fields: [
          { name: "Имя", pii: true },
          { name: "Телефон", pii: true },
        ],
        retention: "3 года",
      },
    ],
    design: { ...(archetype ? { archetype } : {}), references: [] },
  };
}

/** The page_compose tool of the fake composer: the headline of the scenario's page. */
export const submitPage = defineTool({
  name: "submit_page",
  description: "Page of a scenario: its headline.",
  input: z.strictObject({ headline: z.string().min(3).max(120) }),
});

/** The prompt of a fake scenario composition: the brief, the design tokens and the scenario (≈ a real prompt size). */
export function pageComposeMessages(
  ctx: Pick<V3BuildContext, "brief" | "design">,
  s: BriefScenario,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `Ты пишешь страницу сайта на паттернах библиотеки. Дизайн-система:\n${JSON.stringify(ctx.design)}`,
    },
    {
      role: "user",
      content: `Бриф:\n${JSON.stringify(ctx.brief)}\n\nСценарий ${s.id}: когда ${s.when} — ${s.then.join(", ")}`,
    },
  ];
}

const page = (title: string, text: string) => `export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl">${title}</h1>
      <p className="mt-4">${text}</p>
    </main>
  );
}
`;

/** Route of a scenario's page: the module screen of its moduleHint, else /<id>. */
export function scenarioRoute(ctx: Pick<V3BuildContext, "publicFront">, s: BriefScenario): string {
  const screen = ctx.publicFront.screens.find((x) => x.module === s.moduleHint);
  return screen?.route ?? `/${s.id.replace(/_/g, "-")}`;
}

export interface FakeComposerOptions {
  /** page_compose calls per scenario (default 1). */
  calls?: number;
  /** An error to throw instead of composing a scenario (by id and attempt — 1 for the first composition). */
  fail?: (scenarioId: string, attempt: number) => Error | null;
  /** The skeleton calls a model (a breach of the contract). */
  skeletonCallsModel?: boolean;
}

/** A page composer of the V3-12 seam for tests. */
export function fakeComposer(o: FakeComposerOptions = {}): PageComposer & {
  log: { kind: "skeleton" | "scenario"; id?: string; budgetRub: number; briefVersion: number }[];
} {
  const log: { kind: "skeleton" | "scenario"; id?: string; budgetRub: number; briefVersion: number }[] = [];
  const attempts = new Map<string, number>();
  return {
    log,
    async skeleton(ctx: V3BuildContext): Promise<V3ComposeResult> {
      log.push({ kind: "skeleton", budgetRub: ctx.budgetRub, briefVersion: ctx.briefVersion });
      if (o.skeletonCallsModel)
        await ctx.route({
          callType: "page_compose",
          messages: [{ role: "user", content: "каркас" }],
          tools: [submitPage.definition],
          ctx: { orgId: "host" },
        });
      const routes = [
        { route: "/", title: "Главная" },
        ...ctx.publicFront.screens.map((s) => ({ route: s.route, title: s.title })),
      ].filter((r, i, xs) => xs.findIndex((x) => x.route === r.route) === i);
      const name = ctx.brief.goals[0]?.text ?? "Сайт";
      return {
        files: new Map(routes.map((r) => [pageFile(r.route), page(r.title, name)])),
        pages: routes.map((r) => ({ ...r, sections: [{ id: "hero", pattern: "hero-split", props: {} }] })),
        notes: [`Собрал каркас: ${routes.length} страниц`],
        spentRub: 0,
      };
    },
    async scenario(ctx: V3BuildContext, s: BriefScenario): Promise<V3ComposeResult> {
      const n = (attempts.get(s.id) ?? 0) + 1;
      attempts.set(s.id, n);
      log.push({ kind: "scenario", id: s.id, budgetRub: ctx.budgetRub, briefVersion: ctx.briefVersion });
      const err = o.fail?.(s.id, n);
      if (err) throw err;
      let headline = s.when;
      for (let i = 0; i < (o.calls ?? 1); i++) {
        const out = await ctx.route({
          callType: "page_compose",
          messages: pageComposeMessages(ctx, s),
          tools: [submitPage.definition],
          ctx: { orgId: "host" },
        });
        const args = submitPage.parse(out.result.toolCalls[0]?.args ?? {});
        if (args.ok) headline = args.value.headline;
      }
      const route = scenarioRoute(ctx, s);
      return {
        files: new Map([[pageFile(route), page(headline, s.then.join(", "))]]),
        pages: [
          {
            route,
            title: headline.slice(0, 60),
            sections: [{ id: "main", pattern: "signature", props: {} }],
          },
        ],
        notes: [`Сценарий ${s.id}`],
        spentRub: 0,
      };
    },
  };
}

/**
 * Recorded answers of a build: the art director's choice (when the brief has no direction) and `pages` page_compose
 * answers. completionTokens — a heavier answer (usage, so the price) than the default estimate.
 */
export function v3Lines(o: {
  brief: { goals: { text: string }[]; audience: string };
  niche: string;
  seed: string;
  artDirection?: boolean;
  pages: number;
  completionTokens?: number;
  /** A brief + design prompt the page_compose usage is estimated from. */
  prompt: LlmMessage[];
}): FixtureLine[] {
  const lines: FixtureLine[] = [];
  if (o.artDirection) {
    const input = {
      niche: o.niche,
      goals: o.brief.goals.map((g) => g.text),
      audience: o.brief.audience,
      seed: o.seed,
      recent: [],
    };
    const { candidates } = artDirectionCandidates(input);
    const ids = candidates.map((c) => c.archetype);
    const tool = defineTool({
      name: "submit_art_direction",
      description: "art",
      input: artDirectionSchema(ids),
    });
    lines.push(
      fixtureLine("art_direction", artDirectionMessages(input, candidates), [tool.definition], {
        name: "submit_art_direction",
        args: {
          archetype: ids[1] ?? ids[0],
          voice: "warm",
          accentUse: "signal",
          styleName: "Спокойная клиника",
          why: "Спокойный тон и ясная структура помогают записаться с телефона без лишних шагов.",
        },
      }),
    );
  }
  for (let i = 0; i < o.pages; i++) {
    const line = fixtureLine("page_compose", o.prompt, [submitPage.definition], {
      name: "submit_page",
      args: { headline: `Страница сценария ${i + 1}` },
    });
    lines.push(
      o.completionTokens ? { ...line, usage: { ...line.usage, completionTokens: o.completionTokens } } : line,
    );
  }
  return lines;
}

/** Writes recorded answers as <dir>/demo/v3/<name>.jsonl; returns the fixture dir. */
export function writeFixture(name: string, lines: readonly FixtureLine[], dir?: string): string {
  const root = dir ?? mkdtempSync(join(tmpdir(), "wz-v3-fixtures-"));
  mkdirSync(join(root, "demo", "v3"), { recursive: true });
  writeFileSync(join(root, "demo", "v3", `${name}.jsonl`), serializeLines(lines));
  return root;
}
