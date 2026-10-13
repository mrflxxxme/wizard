// V4-19: the records of the v3 stand by stage (tools/fixtures/records/e2e-v3/<callType>.jsonl) and the partial
// re-recording WIZARD_V3_RECORDS=record-stale — a stale stage (an older prompt, a model off the route, no record) and
// every stage after it in the pipeline go live, the earlier ones replay; plain replay still fails loudly on a miss.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRegistry,
  PromptVersions,
  RecordBook,
  type RouteInput,
  type RouteOutput,
  type Router,
  recordingRouter,
} from "../../../packages/llm/src/index.ts";
import { resetV3Records, v3Router } from "../../../packages/e2e/stand/v3-models.ts";
import { liveFromLevel, stageBooks, staleReason, staleStages } from "../../../packages/e2e/stand/v3-records.ts";
import { root } from "./helpers.ts";

const registry = createRegistry({ buildDefaultTier: "T1" });
const versions = new PromptVersions();
const TOOL = { name: "submit", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } };
const ctx = { orgId: "org", systemId: "sys-1" };
const input = (callType: string): RouteInput => ({
  callType,
  messages: [{ role: "user", content: `вход ${callType}` }],
  tools: [TOOL],
  orgPolicy: null,
  ctx,
});
const answer = (model: string): RouteOutput => ({
  tier: "T1",
  model,
  result: { toolCalls: [{ id: "c1", name: "submit", args: { a: model } }], finishReason: "tool-calls" },
  usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 10 },
  creditsCharged: 0.1,
  creditsMilli: 100,
  routeReason: "default_T1",
  scrubbed: false,
  ruFallback: false,
});
/** The head of each stage's route answers (a live router that counts its calls). */
function fakeLive(): Router & { calls: string[] } {
  const calls: string[] = [];
  return {
    mode: "live",
    registry,
    calls,
    async route(i) {
      calls.push(i.callType);
      return answer(registry.routes[i.callType as keyof typeof registry.routes].chain.T1?.[0] ?? "glm-5.3");
    },
  };
}
const STAGES = ["art_direction", "page_compose", "techreview"];

/** A temp repository with one record per stage, recorded by `model(callType)`. */
async function seeded(model: (ct: string) => string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wz-e2e-v3-"));
  for (const ct of STAGES) {
    const book = RecordBook.named(`e2e-v3/${ct}`, dir);
    const rec = recordingRouter(
      { mode: "live", registry, route: async () => answer(model(ct)) },
      { book, source: "e2e", versions },
    );
    await rec.route(input(ct));
  }
  return dir;
}

afterEach(() => {
  resetV3Records();
  delete process.env.WIZARD_V3_RECORDS;
});

describe("V4-19: e2e v3 records by stage", () => {
  test("stale: an older prompt or a model off the route; the error record and a reserve of the chain are fine", () => {
    const line = (o: Partial<{ promptVersion: string; model: string }>) =>
      ({ promptVersion: `${versions.sources("techreview")}.00000000`, model: "gpt-oss-120b", ...o }) as never;
    const o = { versions, registry };
    expect(staleReason("techreview", [line({})], o)).toBeNull();
    expect(staleReason("techreview", [line({ model: "error" })], o)).toBeNull();
    expect(staleReason("techreview", [line({ promptVersion: "deadbeef.00000000" })], o)).toMatch(/промпт изменился/);
    expect(staleReason("techreview", [line({ model: "glm-5.3" })], o)).toBe("модели glm-5.3 нет в маршруте");
  });

  test("a stale stage re-records everything after it in the pipeline", () => {
    expect(liveFromLevel([])).toBe(Number.POSITIVE_INFINITY);
    expect(liveFromLevel(["techreview"])).toBe(5);
    expect(liveFromLevel(["critic_visual", "art_direction"])).toBe(1);
  });

  test("record-stale: only the stale techreview goes live; art_direction and page_compose replay", async () => {
    const dir = await seeded((ct) => (ct === "techreview" ? "glm-5.3" : (registry.routes[ct as "art_direction"].chain.T1?.[0] as string)));
    expect([...staleStages(stageBooks(dir), { versions, registry }).keys()]).toEqual(["techreview"]);
    process.env.WIZARD_V3_RECORDS = "record-stale";
    const live = fakeLive();
    const r = v3Router({ registry }, { root: dir, live });
    for (const ct of STAGES) await r.route(input(ct));
    expect(live.calls).toEqual(["techreview"]);
    // The re-recorded book holds the new answer only; the others are untouched.
    expect(RecordBook.named("e2e-v3/techreview", dir).all().map((l) => l.model)).toEqual([
      registry.routes.techreview.chain.T1?.[0],
    ]);
    expect(staleStages(stageBooks(dir), { versions, registry }).size).toBe(0);
  });

  test("record-stale: a stale art_direction re-records it and every later stage", async () => {
    const dir = await seeded((ct) => (ct === "art_direction" ? "glm-5.3-flash" : "glm-5.3"));
    process.env.WIZARD_V3_RECORDS = "record-stale";
    const live = fakeLive();
    const r = v3Router({ registry }, { root: dir, live });
    for (const ct of STAGES) await r.route(input(ct));
    expect(live.calls).toEqual(STAGES);
  });

  test("record-stale: a stage without a record of its prompt goes live with the later stages", async () => {
    const dir = await seeded(() => "glm-5.3");
    process.env.WIZARD_V3_RECORDS = "record-stale";
    const live = fakeLive();
    const r = v3Router({ registry }, { root: dir, live });
    await r.route(input("art_direction"));
    // page_compose asked with another tool: no record of this prompt version.
    await r.route({ ...input("page_compose"), tools: [{ ...TOOL, name: "submit_page" }] });
    await r.route(input("techreview"));
    expect(live.calls).toEqual(["page_compose", "techreview"]);
  });

  test("replay (CI): no live call, a miss fails loudly with FIXTURE_MISS", async () => {
    const dir = await seeded(() => "glm-5.3");
    const live = fakeLive();
    const r = v3Router({ registry }, { root: dir, live });
    await r.route(input("art_direction"));
    await expect(r.route({ ...input("techreview"), tools: [{ ...TOOL, name: "other" }] })).rejects.toMatchObject({
      code: "FIXTURE_MISS",
    });
    expect(live.calls).toEqual([]);
  });

  test("the records of the repository: one book per stage, none stale", () => {
    const books = stageBooks(root);
    expect(books.size, "нет записей e2e v3 по этапам: запустите stage-probe с e2e_v3").toBeGreaterThan(0);
    const stale = [...staleStages(books, { versions, registry })].map(([ct, why]) => `${ct}: ${why}`);
    expect(stale, "записи e2e v3 устарели: запустите stage-probe с e2e_v3 (перезапишет только эти этапы и следующие)").toEqual([]);
  });
});
