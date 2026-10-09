// V3-12 seam, platform part: «Собрать» on a system brief with the default page writer of a v3 build — the V3-12
// composer on the real ui-kit pattern library (V3-08) — through agents/executors.ts → builds-v3/host.ts → the harness v3
// (V3-11). The skeleton is the real one (no model): every public page from library patterns, registered in the spec from
// the composer's site model (withSitePages over ui/site.json, ui/pages/site/*); the preview G0 and the G0 + G1 of every
// scenario pass. The model of the scenario step is scripted to confirm the skeleton's composition (submit_page with the
// variants and texts it already has), so page_compose runs its checks end to end without recorded answers.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPageComposer, type PageComposer, readSite, type V3BuildContext } from "@wizard/agents/builder";
import { type AppSpec, systemBriefSchema } from "@wizard/appspec";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clinicBrief } from "../../../packages/agents/test/v3-harness-fixtures.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { startV3Build } from "../src/builds-v3/start.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { listEvents } from "../src/runs/events.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

/** Two «must» scenarios of the clinic: the booking and the request (their pages are the composer's). */
function brief() {
  const b = clinicBrief();
  return { ...b, scenarios: (b.scenarios ?? []).filter((s) => ["s_book", "s_lead"].includes(s.id)) };
}

/**
 * A scripted model for page_compose: it confirms the page as the skeleton laid it out (the page's sections with their
 * variants and props from ui/site.json, the page SEO) — a valid submit_page by construction.
 */
function confirming(ctx: V3BuildContext) {
  const calls: string[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input.callType);
    const user = String(input.messages.find((m) => m.role === "user")?.content ?? "");
    const pageRoute = /## Страница (\S+)/.exec(user)?.[1] ?? "/";
    const page = readSite(ctx.files)?.pages.find((p) => p.route === pageRoute);
    const body = (page?.sections ?? []).filter((s) => !["header", "footer", "signature"].includes(s.type));
    const args = {
      sections: body.map((s) => ({ id: s.id, pattern: s.pattern, props: s.props })),
      seo: {
        title: page?.seo.title ?? "Страница сайта клиники",
        description: `${page?.seo.description ?? ""} Запись и заявка на сайте клиники.`.trim().slice(0, 160),
      },
    };
    return {
      tier: "T1",
      model: "glm-5.3",
      result: {
        toolCalls: [{ id: `c${calls.length}`, name: "submit_page", args }],
        finishReason: "tool-calls",
      },
      usage: { inputTokens: 6000, cachedTokens: 0, outputTokens: 900 },
      creditsCharged: 0.4,
      creditsMilli: 400,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, calls };
}

const real = createPageComposer();
const scenarioCalls: string[] = [];
/** The default composer of the platform with the scripted model in its scenario step. */
const composer: PageComposer = {
  skeleton: (ctx) => real.skeleton(ctx),
  scenario: async (ctx, s) => {
    const m = confirming(ctx);
    const out = await real.scenario({ ...ctx, route: m.route }, s);
    scenarioCalls.push(...m.calls);
    return out;
  },
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;

beforeAll(async () => {
  tdb = await createTestDb("v3compose", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v3c-outbox-"));
  api = await startApi(tdb.url, {
    config: { unsafeLocalExec: true },
    executors: ({ pg, config }) =>
      createAgentExecutors({
        pg,
        config,
        v3: { enabled: true, composer, mailer: new OutboxMailer(outboxDir) },
      }),
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
});

describe("platform: «Собрать» with the V3-12 page composer on the real pattern library", () => {
  test("the skeleton on library patterns is the preview; G0 and G1 of every scenario pass; pages from ui/site.json", async () => {
    const key = randomUUID().replace(/-/g, "").slice(0, 12);
    const { id: systemId } = await api.deps.db
      .insertInto("platform.systems")
      .values({
        org_id: DEFAULT_ORG_ID,
        slug: `v3c-${key}`,
        schema_key: key,
        name: "Клиника «Белая линия»",
        pending_questions: json([]),
        created_by: DEV_USER_ID,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await saveBriefVersion(api.deps.db, {
      systemId,
      brief: systemBriefSchema.parse(brief()),
      author: "agent",
    });
    const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    const done = await waitRun(api, run.id, ["succeeded", "failed"], 300_000);
    const ev = await listEvents(api.deps.db, run.id, 0);
    const gates = ev.filter((e) => e.type === "gate_result").map((e) => e.payload);
    expect(done.status, JSON.stringify({ failure: done.failure, gates })).toBe("succeeded");
    // The preview right after the skeleton, then G0 + G1 per scenario: all green.
    const levels = gates.map((g) => g.level);
    const scenarios = (levels.length - 2) / 2;
    expect(scenarios).toBeGreaterThanOrEqual(2);
    expect(levels).toEqual(["G0", ...Array.from({ length: scenarios }, () => ["G0", "G1"]).flat(), "G2"]);
    expect(gates.slice(0, -1).every((g) => g.passed === true)).toBe(true);
    // The scenario step ran page_compose on the composer's pages (the scripted model confirms the skeleton).
    expect(scenarioCalls.length).toBeGreaterThanOrEqual(2);
    expect(scenarioCalls.every((c) => c === "page_compose")).toBe(true);
    // The draft: the public pages of the composer in the spec (ui/pages/site/*), the modules' cabinets kept.
    const [rev] = await api.deps.pg<{ spec: AppSpec }[]>`
      select spec from platform.revisions where system_id = ${systemId} order by version desc limit 1`;
    const pages = rev?.spec.pages ?? [];
    const site = pages.filter((p) => p.file.startsWith("ui/pages/site/"));
    expect(site.map((p) => p.route)).toEqual(expect.arrayContaining(["/"]));
    expect(site.length).toBeGreaterThanOrEqual(2);
    expect(site.find((p) => p.route === "/")?.roles).toContain("guest");
    expect(pages.some((p) => p.route.startsWith("/cabinet"))).toBe(true);
  }, 420_000);
});
