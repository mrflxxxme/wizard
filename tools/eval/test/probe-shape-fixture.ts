// V3-18: the request content of the shape probe (tools/eval/server/probe-shape.mjs), made by the real code of
// @wizard/agents on the synthetic material of its tests — no client data, nothing from any system:
//   critic_visual — critiqueMessages over the clinic of the composer fixtures (its skeleton site, the pattern library,
//     two contrast problems «found by code», the six JPEGs of probe-shape-images.json as the shots) and critiqueTool;
//   techreview — techreviewMessages over the digest of the workshop of the techreview fixtures with its deterministic
//     checks (the size a fixture v3 build makes), the same digest doubled, submitTechreview and the repair turn
//     callTool makes after a refused answer (the tool's own issues, toolError).
// v3-probe.test.ts keeps probe-shape-prompts.json equal to it; WIZARD_UPDATE_PROBE_SHAPE=1 rewrites the file.
import { readFileSync } from "node:fs";
import {
  type CriticShot,
  critiqueMessages,
  critiqueTool,
  type DeterministicProblem,
  deterministicChecks,
  localGates,
  referenceSpec,
  submitTechreview,
  type TechDigest,
  techDigest,
  techreviewMessages,
} from "../../../packages/agents/src/builder/index.ts";
import { siteFacts } from "../../../packages/agents/src/builder/v3/compose/index.ts";
import { toolError } from "../../../packages/agents/src/core/tool.ts";
import { DEFAULT_REGISTRY } from "../../../packages/agents/src/planner/index.ts";
import { criticContext } from "../../../packages/agents/test/v3-critic-fixtures.ts";
import { CUSTOM_FILE, workshopCtx } from "../../../packages/agents/test/v3-techreview-fixtures.ts";
import { PATTERNS } from "../../../packages/ui-kit/src/v3/patterns/index.ts";

export const SHAPE_PROMPTS_PATH = new URL("../server/probe-shape-prompts.json", import.meta.url);
export const SHAPE_IMAGES_PATH = new URL("../server/probe-shape-images.json", import.meta.url);

/** One image of probe-shape-images.json. */
export interface ShapeImage {
  name: string;
  route: string;
  width: number;
  kind: "screen" | "page";
  mime: "image/jpeg";
  px: { width: number; height: number };
  bytes: number;
  data: string;
}

export function shapeImages(): ShapeImage[] {
  return JSON.parse(readFileSync(SHAPE_IMAGES_PATH, "utf8")).images;
}

/** Sections the shots show (as the platform's inspector names them): the clinic's home sections. */
const SECTIONS = {
  screen: ["header", "hero"],
  page: ["header 0–80", "hero 80–900", "services 900–1500", "form 1500–2300", "footer 2300–2700"],
};

/** What the deterministic checks «found» (the model is told not to repeat it). */
const FOUND: DeterministicProblem[] = [
  {
    code: "C08",
    route: "/",
    width: 390,
    scheme: "light",
    section: "hero",
    message_ru: "p «текст»: контраст 4.10 при норме 4.5",
  },
  {
    code: "C08",
    route: "/",
    width: 390,
    scheme: "light",
    section: "services",
    message_ru: "p «текст»: контраст 4.20 при норме 4.5",
  },
];

/** The digest twice as large: every list doubled with renamed copies (synthetic). */
export function doubledDigest(d: TechDigest): TechDigest {
  const copy = (s: string) => `${s} (копия 2)`;
  const file2 = (f: string) => f.replace(/(\.[a-z]+)$/, "2$1");
  return {
    ...d,
    scenarios: [...d.scenarios, ...d.scenarios.map(copy)],
    entities: [...d.entities, ...d.entities.map((e) => ({ ...e, name: `${e.name}2`, label: copy(e.label) }))],
    permissions: [...d.permissions, ...d.permissions.map(copy)],
    workflows: [...d.workflows, ...d.workflows.map(copy)],
    functions: [
      ...d.functions,
      ...d.functions.map((f) => ({ ...f, name: `${f.name}2`, file: file2(f.file) })),
    ],
    extensions: [...d.extensions, ...d.extensions.map(copy)],
    pages: [...d.pages, ...d.pages.map(copy)],
    custom: [...d.custom, ...d.custom.map((c) => ({ ...c, file: file2(c.file) }))],
    checks: {
      open: [...d.checks.open, ...d.checks.open.map((c) => ({ ...c, id: `${c.id}-2` }))],
      passed: Object.fromEntries(Object.entries(d.checks.passed).map(([k, n]) => [k, n * 2])),
    },
  };
}

/** The content of probe-shape-prompts.json. */
export async function shapePrompts(images: ShapeImage[] = shapeImages()) {
  const ctx = await criticContext();
  const shots: CriticShot[] = images.map((im) => ({
    route: im.route,
    width: im.width as CriticShot["width"],
    kind: im.kind,
    maxWidth: im.px.width,
    maxHeight: im.px.height,
    mime: im.mime,
    data: im.data,
    px: im.px,
    sections: SECTIONS[im.kind],
  }));
  const critic = critiqueMessages({
    facts: siteFacts(ctx),
    brief: ctx.brief,
    site: ctx.site,
    design: ctx.design,
    library: PATTERNS,
    shots,
    found: FOUND,
    history: [],
    stubPhotos: true,
  });

  const wctx = workshopCtx({
    route: async () => {
      throw new Error("no model in the fixture");
    },
  });
  const reference = referenceSpec(wctx.plan, DEFAULT_REGISTRY);
  const system = { spec: wctx.spec, files: wctx.files };
  const checks = await deterministicChecks(system, {
    plan: wctx.plan,
    reference,
    evidence: [],
    gates: localGates,
    contracts: [],
  });
  const digest = techDigest({ brief: wctx.brief, plan: wctx.plan, system, reference, checks, fixes: [] });
  const digest2 = doubledDigest(digest);
  const [sys, user1] = techreviewMessages(digest, 1, 2);
  const [, user2] = techreviewMessages(digest2, 1, 2);
  // The repair turn of callTool: the answer with a severity outside the closed set, the tool's own issues.
  const args = {
    findings: [
      {
        severity: "critical",
        area: "errors",
        title_ru: "Функция статуса заявки не обрабатывает отсутствующую заявку",
        evidence: { kind: "file", ref: CUSTOM_FILE },
        fix: { kind: "none" },
      },
    ],
  };
  const parsed = submitTechreview.parse(args);
  if (parsed.ok) throw new Error("the repair answer must fail the tool's check");
  return {
    v: 1,
    source:
      "tools/eval/test/probe-shape-fixture.ts (WIZARD_UPDATE_PROBE_SHAPE=1 pnpm exec vitest run tools/eval/test/v3-probe.test.ts)",
    critic: {
      system: critic[0]?.content as string,
      user: critic[1]?.content as string,
      tool: critiqueTool.definition,
    },
    techreview: {
      system: sys?.content as string,
      user1: user1?.content as string,
      user2: user2?.content as string,
      tool: submitTechreview.definition,
      digestChars: [JSON.stringify(digest).length, JSON.stringify(digest2).length],
      repair: {
        assistant: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_shape_1", name: submitTechreview.name, args }],
        },
        tool: {
          role: "tool",
          toolCallId: "call_shape_1",
          toolName: submitTechreview.name,
          content: toolError(
            "INVALID_ARGS",
            "Аргументы не прошли проверку, исправь и вызови снова.",
            parsed.issues,
          ),
        },
      },
    },
  };
}
