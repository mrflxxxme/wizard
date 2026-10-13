// V4-03 stage adapters of the probe (tools/fixtures/probe.mjs): each runs one real stage of the build — its current
// prompt code in packages/agents — on a saved input (tools/fixtures/probe/inputs/<stage>/*.json) with the given route.
// A stage owner adds the adapter of a new stage here. `raw` sends a saved RouteInput as is (any callType).
import {
  type BriefScenario,
  type SystemBrief,
  systemBriefSchema,
} from "../../../packages/appspec/src/index.ts";
import type {
  LlmMessage,
  LlmTool,
  OrgPolicy,
  RouteInput,
  RouteOutput,
} from "../../../packages/llm/src/index.ts";
import { PATTERNS } from "../../../packages/ui-kit/src/v3/patterns/index.ts";
import { dentalBrief, shopBrief } from "../../../packages/appspec/test/brief-fixtures.ts";
import { composeContext } from "../../../packages/agents/test/v3-compose-fixtures.ts";
import { extractBriefDraft } from "../../../packages/agents/src/brief-extract/index.ts";
import {
  type ArtDirectorInput,
  createPageComposer,
  directionsNiche,
  proposeDirections,
  runArtDirector,
  runTechreview,
} from "../../../packages/agents/src/builder/index.ts";
import type { V3BuildContext } from "../../../packages/agents/src/builder/v3/contract.ts";
import {
  createInterviewV3,
  newInterviewV3Session,
} from "../../../packages/agents/src/interview-v3/index.ts";

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
async function builtClinic(route: RouteFn, systemId: string, photos = true): Promise<V3BuildContext> {
  const base = { ...composeContext({ photos, systemId }), route, budgetRub: 40 };
  const out = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
  const files = new Map(base.files);
  for (const [p, v] of out.files) {
    if (v === null) files.delete(p);
    else files.set(p, v);
  }
  return { ...base, files };
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
