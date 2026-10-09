// V3-13: test material of the visual critic, built by code. The clinic of the composer fixtures with its skeleton site
// (real pattern library), a fake inspector whose deterministic problems follow rules over the files it gets, and the
// recorded critic_visual answers (suite demo — answers by order; usage from the real prompt without the image bytes plus
// the image tokens of the screenshots, so the cost is the models.yaml price of the T0 vision model).
import type { FixtureLine, LlmMessage, RouteInput } from "@wizard/llm";
import { createRegistry, createRouter, withoutAttachmentBytes } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import {
  type CriticInspectInput,
  type CriticInspector,
  type CriticShot,
  type CriticViewport,
  type Critique,
  createPageComposer,
  critiqueMessages,
  critiqueTool,
  type DeterministicProblem,
  imageTokens,
  readSite,
  type SiteModel,
  shotPlan,
  type V3BuildContext,
  withSitePages,
} from "../src/builder/index.js";
import { siteFacts, siteFiles } from "../src/builder/v3/compose/index.js";
import { fixtureLine } from "./build-v2-fixtures.js";
import { composeContext } from "./v3-compose-fixtures.js";
import { writeFixture } from "./v3-harness-fixtures.js";

export const OPEN = { ruOnly: false, t1Restricted: false };
export const registry = createRegistry({ buildDefaultTier: "T1" });

/** The clinic after the skeleton: its files with ui/site.json, the spec with the site pages. */
export async function criticContext(
  o: { budgetRub?: number } = {},
): Promise<V3BuildContext & { site: SiteModel }> {
  const ctx = composeContext();
  const sk = await createPageComposer().skeleton(ctx);
  const files = new Map(ctx.files);
  for (const [p, v] of sk.files) v === null ? files.delete(p) : files.set(p, v);
  const composed = readSite(files);
  if (!composed) throw new Error("no site");
  // The recorded critiques are about the clinic's home of V3-13 (hero, services, form): the previews V3-18 added to
  // home (the catalog's first items, the contacts) are left out of this fixture.
  const site: SiteModel = {
    ...composed,
    pages: composed.pages.map((p) =>
      p.route === "/"
        ? { ...p, sections: p.sections.filter((s) => s.type !== "catalog" && s.type !== "contacts") }
        : p,
    ),
  };
  for (const [p, v] of siteFiles(site, siteFacts(ctx).copy.site, ctx.design, files))
    v === null ? files.delete(p) : files.set(p, v);
  return { ...ctx, files, spec: withSitePages(ctx.spec, site), budgetRub: o.budgetRub ?? 40, site };
}

/** A rule of the fake browser: problems of one page at one viewport, from the files under check. */
export type InspectRule = (
  q: { site: SiteModel; files: ReadonlyMap<string, string> },
  route: string,
  vp: CriticViewport,
) => Omit<DeterministicProblem, "route" | "width" | "scheme">[];

/** A section of the page uses `pattern` → `code` in that section at the widths given (all when none). */
export const whenPattern =
  (pattern: string, code: DeterministicProblem["code"], widths?: readonly number[]): InspectRule =>
  ({ site }, route, vp) => {
    if (widths && !widths.includes(vp.width)) return [];
    const page = site.pages.find((p) => p.route === route);
    return (page?.sections ?? [])
      .filter((s) => s.pattern === pattern)
      .map((s) => ({ code, section: s.id, message_ru: `${code} в варианте ${pattern}` }));
  };

/** The design CSS still has `text` → `code` in two sections of the home page (light theme). */
export const whenCss =
  (text: string, code: DeterministicProblem["code"]): InspectRule =>
  ({ files }, route, vp) =>
    route === "/" && vp.scheme === "light" && files.get("ui/design.css")?.includes(text)
      ? [
          { code, section: "hero", message_ru: "p «текст»: контраст 4.10 при норме 4.5" },
          { code, section: "services", message_ru: "p «текст»: контраст 4.20 при норме 4.5" },
        ]
      : [];

/** Screenshots as the platform sends them: the sizes asked, a page overview 1800 px high. */
export function fakeShots(input: Pick<CriticInspectInput, "shots">): CriticShot[] {
  return input.shots.map((s) => ({
    ...s,
    mime: "image/jpeg",
    data: Buffer.from(`${s.route}@${s.width}:${s.kind}`).toString("base64"),
    px: { width: s.maxWidth, height: s.kind === "page" ? 1800 : s.maxHeight },
    sections: s.kind === "page" ? ["header 0–80", "hero 80–900", "services 900–1500"] : ["header", "hero"],
  }));
}

/** The fake browser: every page × viewport through the rules; calls are recorded. */
export function fakeInspector(rules: InspectRule[], calls: CriticInspectInput[] = []): CriticInspector {
  return async (input) => {
    calls.push(input);
    const site = readSite(input.files);
    if (!site) return { ok: false, error: "нет сайта", problems: [], shots: [] };
    const problems: DeterministicProblem[] = [];
    for (const route of input.routes)
      for (const vp of input.viewports)
        for (const rule of rules)
          for (const p of rule({ site, files: input.files }, route, vp))
            problems.push({ ...p, route, width: vp.width, scheme: vp.scheme });
    return { ok: true, problems, shots: fakeShots(input), stubPhotos: true };
  };
}

/** The prompt of the first cycle on the clinic and its screenshots (their usage prices every recorded answer). */
export function firstPrompt(ctx: V3BuildContext & { site: SiteModel }) {
  const shots = fakeShots({ shots: shotPlan(ctx.site) });
  const messages = critiqueMessages({
    facts: siteFacts(ctx),
    brief: ctx.brief,
    site: ctx.site,
    design: ctx.design,
    library: PATTERNS,
    shots,
    found: [],
    history: [],
    stubPhotos: true,
  });
  return { messages, imageTokens: shots.reduce((s, x) => s + imageTokens(x.px.width, x.px.height), 0) };
}

/** Recorded submit_critique answers; usage — the prompt's text tokens plus the image tokens of its screenshots. */
export function critiqueLines(
  prompt: { messages: LlmMessage[]; imageTokens: number },
  answers: readonly unknown[],
): FixtureLine[] {
  const text = withoutAttachmentBytes(prompt.messages);
  return answers.map((args) => {
    const line = fixtureLine("critic_visual", text, [critiqueTool.definition], {
      name: "submit_critique",
      args,
    });
    line.usage.promptTokens += prompt.imageTokens;
    return line;
  });
}

let seq = 0;
/** ctx.route over a fixture router of the answers (T1 open by policy: the images keep the call on T0). */
export function fixtureRoute(lines: readonly FixtureLine[]) {
  seq += 1;
  const name = `critic-${process.pid}-${seq}`;
  const dir = writeFixture(name, lines);
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: `v3/${name}`, dir },
    registry,
    sink: { write: async () => {} },
    env: {},
  });
  const calls: RouteInput[] = [];
  const route: V3BuildContext["route"] = async (input) => {
    calls.push(input);
    return router.route({ ...input, orgPolicy: OPEN, ctx: { orgId: "org" } });
  };
  return { route, calls, dir };
}

/** A critique answer: axes (one number for all, or per axis over 3), polish and findings. */
export function critique(
  axes: number | Partial<Critique["axes"]>,
  findings: unknown[] = [],
  polish: Critique["polish"] = "draft",
): Record<string, unknown> {
  const all = typeof axes === "number" ? axes : 3;
  const per = typeof axes === "number" ? {} : axes;
  return {
    axes: {
      specificity: all,
      first_screen: all,
      typography: all,
      color: all,
      composition: all,
      content: all,
      ...per,
    },
    polish,
    findings,
  };
}
