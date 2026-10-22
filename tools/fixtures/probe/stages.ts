// V4-03 stage adapters of the probe (tools/fixtures/probe.mjs): each runs one real stage of the build — its current
// prompt code in packages/agents — on a saved input (tools/fixtures/probe/inputs/<stage>/*.json) with the given route.
// A stage owner adds the adapter of a new stage here. `raw` sends a saved RouteInput as is (any callType).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BriefScenario,
  type SystemBrief,
  systemBriefSchema,
} from "../../../packages/appspec/src/index.ts";
import {
  createRegistry,
  type LlmMessage,
  LlmTool,
  OrgPolicy,
  RouteInput,
  RouteOutput,
} from "../../../packages/llm/src/index.ts";
import { PATTERNS } from "../../../packages/ui-kit/src/v3/patterns/index.ts";
import { type ArchetypeId, designSystemV3 } from "../../../packages/ui-kit/src/v3/design/index.ts";
import { dentalBrief, shopBrief } from "../../../packages/appspec/test/brief-fixtures.ts";
import { composeContext } from "../../../packages/agents/test/v3-compose-fixtures.ts";
import { extractBriefDraft } from "../../../packages/agents/src/brief-extract/index.ts";
import {
  type ArtDirectorInput,
  CRITIC_CALL_TYPE,
  createPageComposer,
  critiqueMessages,
  critiqueScore,
  critiqueTool,
  directionsNiche,
  shotPlan,
  pointEditV3,
  withSitePages,
  proposeDirections,
  runArtDirector,
  runTechreview,
} from "../../../packages/agents/src/builder/index.ts";
import type { V3BuildContext } from "../../../packages/agents/src/builder/v3/contract.ts";
import { siteFacts } from "../../../packages/agents/src/builder/v3/compose/index.ts";
import { readSite } from "../../../packages/agents/src/builder/v3/compose/site.ts";
import { runRoles, RolesFailure } from "../../../packages/agents/src/builder/v4/index.ts";
import { callTool } from "../../../packages/agents/src/core/loop.ts";
import { defaultAuthorFamilies, runCritic } from "../../../packages/agents/src/builder/v3/critic/hook.ts";
import { siteFiles } from "../../../packages/agents/src/builder/v3/compose/codegen.ts";
import type { Critique } from "../../../packages/agents/src/builder/v3/critic/rubric.ts";
import type { CriticShot } from "../../../packages/agents/src/builder/v3/critic/types.ts";
import { chromiumProvider } from "../../../apps/platform-api/src/agents/goal-browser.ts";
import { criticInspector } from "../../../apps/platform-api/src/builds-v3/critic.ts";
import { CRITIC_VIEWPORTS } from "../../../packages/agents/src/builder/v3/critic/checks.ts";
import {
  createInterviewV3,
  newInterviewV3Session,
} from "../../../packages/agents/src/interview-v3/index.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

export type RouteFn = (input: RouteInput) => Promise<RouteOutput>;

/** The probe calls as an org without restrictions (build stages, D79 (3)). */
export const OPEN: OrgPolicy = { ruOnly: false, t1Restricted: false };

export interface StageRun {
  /** The stage took its deterministic fallback (the model's answer was not used). */
  fallback: boolean;
  /** One line about the result for the report (Russian). */
  summary: string;
}

export interface Stage {
  /** callTypes the stage calls (the push trigger maps prompt files to stages by them). */
  callTypes: readonly string[];
  run(input: Record<string, unknown>, route: RouteFn, ctx: { orgId: string; systemId: string }): Promise<StageRun>;
}

const BRIEFS: Record<string, () => unknown> = { dental: dentalBrief, shop: shopBrief };

function brief(name: unknown): SystemBrief {
  const make = BRIEFS[String(name)];
  if (!make) throw new Error(`неизвестный бриф ${String(name)}: ${Object.keys(BRIEFS).join(", ")}`);
  return systemBriefSchema.parse({ ...(make() as object), design: { references: [] } });
}

/** The fixture clinic after the skeleton, with the probe's route (page_compose, techreview). */
/** Points the critic's score of the same shots may differ by between calls of one model. */
export const CRITIC_SPREAD = 20;

/**
 * The probe's route for the stages' own calls: the platform's queue gives every call its org's policy (orgs.t1_restricted
 * false by default); a stage that calls without one (the composer, the techreview, the point edit) would be held to T0
 * by decideTier (policy_region_restricted) — the probe takes the open policy unless the caller set one.
 */
export const withOpenPolicy =
  (route: RouteFn): RouteFn =>
  (ri) =>
    route({ ...ri, orgPolicy: ri.orgPolicy ?? OPEN });

async function builtClinic(
  route: RouteFn,
  systemId: string,
  photos = true,
  archetype?: ArchetypeId,
): Promise<V3BuildContext> {
  // The phone is the redaction stand-in: records keep it as it is, the replayed page still quotes the facts.
  const fixture = composeContext({ photos, systemId, contact: "+7 900 000-00-00" });
  const design = archetype
    ? designSystemV3({ archetype, brandColor: "#2a7f9e", seed: 7, niche: fixture.plan.niche })
    : fixture.design;
  const base = { ...fixture, design, route: withOpenPolicy(route), budgetRub: 40 };
  const out = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
  const files = new Map(base.files);
  for (const [p, v] of out.files) {
    if (v === null) files.delete(p);
    else files.set(p, v);
  }
  return { ...base, files };
}

/**
 * The clinic with its home hero written as code (the page-by-sections composer, rehearsal №5): the source of
 * tools/fixtures/probe/heroes/<name>.tsx in ui/sections/home-hero.tsx, the photo given by its address (codePhotos).
 */
function withCodeHero(built: V3BuildContext, name: string): V3BuildContext {
  const site = readSite(built.files);
  const home = site?.pages.find((p) => p.route === "/");
  const hero = home?.sections.find((x) => x.type === "hero");
  if (!site || !home || !hero) throw new Error("в клинике нет первого экрана главной");
  const file = "ui/sections/home-hero.tsx";
  const photo = hero.props.image as { src?: string; alt?: string } | undefined;
  const code = {
    id: hero.id,
    type: "signature",
    pattern: "signature",
    title: "Первый экран",
    file,
    props: {
      title: hero.props.title,
      lead: hero.props.lead,
      action: hero.props.action,
      ...(photo?.src ? { image: photo.src, imageAlt: photo.alt ?? "" } : {}),
    },
    ...(hero.photos ? { photos: hero.photos } : {}),
  } as typeof hero;
  const next = {
    ...site,
    pages: site.pages.map((p) =>
      p === home ? { ...p, sections: p.sections.map((x) => (x === hero ? code : x)) } : p,
    ),
  };
  const source = readFileSync(join(REPO_ROOT, "tools", "fixtures", "probe", "heroes", `${name}.tsx`), "utf8");
  const files = new Map(built.files);
  for (const [p, v] of siteFiles(next, siteFacts(built).copy.site, built.design, built.files, new Map([[file, source]]), PATTERNS)) {
    if (v === null) files.delete(p);
    else files.set(p, v);
  }
  return { ...built, files };
}

/** A saved screenshot of a real build (the acceptance rehearsal): the critic judges it instead of the probe clinic. */
interface SavedShot {
  file: string;
  width: 390 | 1440;
  kind: "screen" | "page";
  px: { width: number; height: number };
}

/** Critic messages over the clinic's live screenshots (the shot plan of the critic hook). */
async function liveShotMessages(
  built: V3BuildContext,
  site: NonNullable<ReturnType<typeof readSite>>,
  browser: ReturnType<typeof chromiumProvider>,
): Promise<LlmMessage[]> {
  const shots = shotPlan(site);
  const insp = await criticInspector({ browser })({
    // As the critic hook: the spec routes the site's pages (without them every route is «не найдена»).
    spec: withSitePages(built.spec, site),
    files: built.files,
    routes: [...new Set(shots.map((x) => x.route))],
    viewports: CRITIC_VIEWPORTS,
    shots,
    fonts: [built.design.fonts.display.family, built.design.fonts.text.family],
  });
  if (!insp.ok) throw new Error(`снимки не сняты: ${insp.error ?? ""}`);
  return critiqueMessages({
    facts: siteFacts(built),
    brief: built.brief,
    site,
    design: built.design,
    library: PATTERNS,
    shots: insp.shots,
    found: insp.problems,
    stubPhotos: insp.stubPhotos === true,
    history: [],
    code: new Map(
      [...new Set(shots.map((x) => x.route))].flatMap((rt) => {
        const file = site.pages.find((pg) => pg.route === rt)?.file;
        const src = file ? built.files.get(file) : undefined;
        return file && src !== undefined ? [[file, src] as const] : [];
      }),
    ),
  });
}

/** Critic messages over saved screenshots: the clinic gives the brief and the site, not its code (another page). */
function savedShotMessages(
  built: V3BuildContext,
  site: NonNullable<ReturnType<typeof readSite>>,
  saved: readonly SavedShot[],
): LlmMessage[] {
  const shots: CriticShot[] = saved.map((x) => ({
    route: "/",
    width: x.width,
    kind: x.kind,
    maxWidth: x.px.width,
    maxHeight: x.px.height,
    mime: "image/jpeg",
    data: readFileSync(join(REPO_ROOT, x.file)).toString("base64"),
    px: x.px,
    sections: [],
  }));
  return critiqueMessages({
    facts: siteFacts(built),
    brief: built.brief,
    site,
    design: built.design,
    library: PATTERNS,
    shots,
    found: [],
    stubPhotos: false,
    history: [],
    code: new Map(),
  });
}

/** What a critique of the rehearsal clinic caught: placeholders, the empty section, the brand in the menu; its findings. */
function caught(c: Critique): string {
  const text = c.findings.map((f) => `${f.evidence} ${f.replace ?? ""}`).join(" ");
  const marks = [
    /Услуга\s*\d|заглушк|плейсхолдер/i.test(text) ? "заглушки ✓" : "заглушки ✗",
    /пуст|только заголов|одна кнопка|без содержан/i.test(text) ? "пустая секция ✓" : "пустая секция ✗",
    /бренд|название.{0,40}(меню|навигац|шапк)|логотип/i.test(text) ? "бренд в меню ✓" : "бренд в меню ✗",
  ];
  const top = c.findings.map((f) => `${f.severity} ${f.sign} ${f.where}`).join(", ");
  return `${marks.join(", ")} [${top}]`;
}

export const STAGES: Record<string, Stage> = {
  interview_v3: {
    callTypes: ["interview_v3"],
    async run(input, route, ctx) {
      const iv = createInterviewV3({ route, orgPolicy: OPEN, ctx });
      const r = await iv.start(newInterviewV3Session(), { prompt: String(input.prompt) });
      return {
        fallback: Boolean(r.failure),
        summary: r.failure ? `сбой: ${JSON.stringify(r.failure)}` : `ответов: ${r.outputs.length}`,
      };
    },
  },
  brief_extract: {
    callTypes: ["brief_extract"],
    async run(input, route, ctx) {
      const r = await extractBriefDraft({ text: String(input.text), route, orgPolicy: OPEN, ctx });
      return {
        fallback: r.method !== "model",
        summary: `метод ${r.method}, частей ${r.answered}/${r.chunks}, целей ${r.brief.goals.length}`,
      };
    },
  },
  art_direction: {
    callTypes: ["art_direction"],
    async run(input, route, ctx) {
      const r = await runArtDirector({ input: input as unknown as ArtDirectorInput, route, orgPolicy: OPEN, ctx });
      return {
        fallback: r.fallback,
        summary: `выбран ${r.choice ? JSON.stringify(r.choice).slice(0, 120) : "—"}`,
      };
    },
  },
  direction_texts: {
    callTypes: ["art_direction"],
    async run(input, route, ctx) {
      const name = String(input.name);
      const r = await proposeDirections(
        {
          brief: brief(input.brief),
          name,
          niche: directionsNiche(name, typeof input.request === "string" ? input.request : null),
          seed: String(input.seed ?? ctx.systemId),
        },
        { route, orgPolicy: OPEN, ctx },
      );
      return { fallback: r.fallback, summary: `направлений ${r.directions.length}` };
    },
  },
  page_compose: {
    callTypes: ["page_compose", "signature_section"],
    async run(input, route, ctx) {
      const built = await builtClinic(route, ctx.systemId, input.photos !== false);
      const id = String(input.scenario ?? "lead");
      const scenario = built.brief.scenarios.find((s) => s.id === id) as BriefScenario | undefined;
      if (!scenario) throw new Error(`в брифе клиники нет сценария ${id}`);
      const r = await createPageComposer({ patterns: PATTERNS }).scenario(built, scenario);
      return {
        fallback: r.files.size === 0,
        summary: `файлов ${r.files.size}, ${r.spentRub.toFixed(2)} ₽; ${r.notes.join(" ").slice(0, 160)}`,
      };
    },
  },
  techreview: {
    callTypes: ["techreview"],
    async run(input, route, ctx) {
      const built = await builtClinic(route, ctx.systemId, input.photos !== false);
      const r = await runTechreview(built, { maxRounds: Number(input.rounds ?? 1) });
      return {
        fallback: false,
        summary: `находок ${r.findings.length}, блокеров ${r.blockers.length}`,
      };
    },
  },
  point_edit: {
    callTypes: ["page_compose"],
    async run(input, route, ctx) {
      const built = await builtClinic(route, ctx.systemId, input.photos !== false);
      const file = String(input.file ?? "ui/pages/site/Home.tsx");
      const source = built.files.get(file);
      if (source === undefined) throw new Error(`в клинике нет файла ${file}`);
      const needle = String(input.near ?? "");
      const line = needle ? source.split("\n").findIndex((l) => l.includes(needle)) + 1 : 1;
      const r = await pointEditV3({
        input: {
          target: {
            file,
            line: Math.max(1, line),
            componentName: String(input.component ?? ""),
            route: String(input.route ?? "/"),
            instruction: String(input.instruction),
          },
          source,
        },
        route,
        orgPolicy: OPEN,
        ctx,
      });
      return { fallback: !r.ok, summary: r.ok ? r.summary : `отказ: ${r.reason}` };
    },
  },
  // V4-09: the critic on the real screenshots 390/1440 of the clinic, asked `repeats` times on the same shots — its
  // latency per call (target ≤ 90 s) and the spread of its score (≤ 10 points, the stability of the critic).
  critic_visual: {
    callTypes: ["critic_visual"],
    async run(input, route, ctx) {
      const built = await builtClinic(
        route,
        ctx.systemId,
        input.photos !== false,
        input.archetype as ArchetypeId | undefined,
      );
      const site = readSite(built.files);
      if (!site) throw new Error("в клинике нет модели сайта");
      const browser = chromiumProvider({ slots: 1 });
      try {
        const messages = input.shots
          ? savedShotMessages(built, site, input.shots as SavedShot[])
          : await liveShotMessages(built, site, browser);
        // Score and model of each answer: the spread is judged among the answers of one model (a fallback model
        // under the provider's rate limit is another critic, shown apart).
        const answers: { model: string; score: number }[] = [];
        const seen: string[] = [];
        const ms: number[] = [];
        const repeats = Math.max(1, Math.min(3, Number(input.repeats ?? 3)));
        for (let i = 0; i < repeats; i++) {
          const t0 = Date.now();
          let model = "";
          const r = await callTool({
            // As on the platform: the critic is never of the page writer's family.
            route: async (ri) => {
              const out = await route(
                input.avoid === false ? ri : { ...ri, avoidFamilies: defaultAuthorFamilies(createRegistry()) },
              );
              model = out.model;
              return out;
            },
            callType: CRITIC_CALL_TYPE,
            orgPolicy: OPEN,
            ctx,
            stepName: `critic_visual:${i + 1}`,
            messages,
            tool: critiqueTool,
            maxRepairs: 1,
          });
          ms.push(Date.now() - t0);
          if (r.ok) {
            answers.push({ model, score: critiqueScore(r.value) });
            if (input.shots) seen.push(caught(r.value));
          }
        }
        const byModel = new Map<string, number[]>();
        for (const a of answers) byModel.set(a.model, [...(byModel.get(a.model) ?? []), a.score]);
        const main = [...byModel.values()].sort((a, b) => b.length - a.length)[0] ?? [];
        const spread = main.length ? Math.max(...main) - Math.min(...main) : 0;
        const slowest = Math.max(...ms);
        const median = [...ms].sort((x, y) => x - y)[Math.floor(ms.length / 2)] as number;
        const scores = [...byModel].map(([m, xs]) => `${m}: ${xs.join(", ")}`).join("; ");
        // The score only stops the cycles (the checks accept edits): a model's noise up to CRITIC_SPREAD is tolerated.
        return {
          fallback: answers.length < repeats || main.length < 2 || spread > CRITIC_SPREAD || median > 90_000,
          summary: `оценки ${scores || "—"} (разброс у одной модели ${spread}); вызов: медиана ${Math.round(median / 1000)} с, самый долгий ${Math.round(slowest / 1000)} с${seen.length ? `; ${seen.join(" | ")}` : ""}`,
        };
      } finally {
        await browser.close();
      }
    },
  },
  // V4-09: the whole critic stage (checks, the model, its edits applied and checked in the browser) on the clinic whose
  // home hero is written as code — what became of each finding: applied, rejected (and why) or without an edit.
  critic_cycle: {
    callTypes: ["critic_visual"],
    async run(input, route, ctx) {
      const clinic = await builtClinic(route, ctx.systemId, input.photos !== false);
      const coded = input.hero ? withCodeHero(clinic, String(input.hero)) : clinic;
      const site = readSite(coded.files);
      if (!site) throw new Error("в клинике нет модели сайта");
      // As the harness: the spec routes the site's pages (without them every route is «не найдена»).
      const built = { ...coded, spec: withSitePages(coded.spec, site) };
      const browser = chromiumProvider({ slots: 1 });
      try {
        const r = await runCritic(built, {
          inspect: criticInspector({ browser }),
          verify: null,
          maxCycles: Number(input.cycles ?? 2),
          budgetRub: Number(input.budgetRub ?? 8),
          orgPolicy: OPEN,
          routeCtx: ctx,
        });
        const list = (xs: readonly string[]) => (xs.length ? xs.join("; ") : "—");
        const cycles = r.cycles.map(
          (c) =>
            `цикл ${c.n} (${c.model ?? "?"}): ${c.score}, находок ${c.findings}; применены: ${list(c.applied)}; отклонены: ${list(c.rejected.map((x) => `${x.edit} — ${x.reason_ru}`))}; без правки: ${list(c.noEdit ?? [])}`,
        );
        const scores = r.cycles.map((c) => c.score);
        const left = [...new Set(r.left.map((x) => `${x.code} ${x.route}#${x.section ?? "—"}`))].slice(0, 6);
        return {
          // The stage reached the model and applied at least one of its edits.
          fallback: r.status !== "done" || !r.cycles.length || r.cycles.every((c) => !c.applied.length),
          summary: `оценки ${scores.join(" → ") || "—"}, стоп ${r.stop}; проверки: штраф ${r.before.penalty} → ${r.after.penalty}, осталось ${list(left)}; правки без модели: ${list(r.fixes)}; ${cycles.join(" | ")}; ${r.spentRub.toFixed(2)} ₽`,
        };
      } finally {
        await browser.close();
      }
    },
  },
  // V5-03: the chain of roles on a saved business: strategist → copywriter → editor → director → signature section
  // (two candidates and a judge). No browser here: the critic's slot rounds are covered by the harness test; the probe
  // reports the models by role, the cost and the bans the final page still trips.
  roles: {
    callTypes: ["role_strategist", "role_copywriter", "role_editor", "role_director", "role_judge", "signature_section"],
    async run(input, route, ctx) {
      const registry = createRegistry();
      let credits = 0;
      const counted: RouteFn = async (ri) => {
        const out = await route(ri);
        credits += out.creditsCharged;
        return out;
      };
      const photos = (input.photos as string[]).map((alt, i) => ({
        src: `/_wizard/photos/0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a${String(i).padStart(2, "0")}/1600`,
        alt,
        credit: "Автор, pexels",
      }));
      try {
        const r = await runRoles({
          homeFile: "ui/pages/site/Home.tsx",
          registry,
          base: { route: withOpenPolicy(counted), orgPolicy: OPEN, ctx },
          input: {
            name: String(input.name),
            request: String(input.request),
            brief: {
              goals: (input.goals as string[]).map((text, i) => ({ id: `g${i + 1}`, text, success: text })),
              audience: String(input.audience),
              qa: input.qa as never,
              assumptions: [],
              scenarios: [],
            },
            photos,
          },
        });
        const rub = (credits * registry.rubPerCredit).toFixed(1);
        return {
          fallback: false,
          summary: `${r.page.direction}, блоков ${r.page.blocks.length}, фирменная ${r.signature?.winner ?? "нет"}; модели ${Object.entries(r.report.models).map(([k, v]) => `${k}=${v}`).join(" ")}; ${rub} ₽; ${r.report.notes.join(" | ").slice(0, 200)}`,
        };
      } catch (e) {
        if (!(e instanceof RolesFailure)) throw e;
        return { fallback: true, summary: `роль ${e.role} не дала результата: ${e.message}` };
      }
    },
  },
  raw: {
    callTypes: [],
    async run(input, route, ctx) {
      const out = await route({
        callType: String(input.callType),
        messages: input.messages as LlmMessage[],
        ...(input.tools ? { tools: input.tools as LlmTool[] } : {}),
        ...(input.toolChoice ? { toolChoice: input.toolChoice as RouteInput["toolChoice"] } : {}),
        orgPolicy: OPEN,
        ctx,
      });
      return {
        fallback: false,
        summary: `${out.result.finishReason}: ${out.result.toolCalls.map((c) => c.name).join(", ") || (out.result.text ?? "").slice(0, 80)}`,
      };
    },
  },
};
