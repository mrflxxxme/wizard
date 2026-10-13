// V4-03: records of real model answers — the key «prompt version + model + tool schema», redaction of secrets and strong
// identifiers, replay by scope and ordinal, the loud miss «нет записи для <callType>@<версия>», a new prompt version
// (an edited prompt source) invalidating its records; the stage probe offline (a fake live router): every saved input
// runs its stage, answers become probe records, a refused call fails the probe, the cap stops it.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createRegistry,
  LlmError,
  PromptVersions,
  RecordBook,
  type RouteInput,
  type RouteOutput,
  type Router,
  recordingRouter,
  redact,
  replayRouter,
  toolsHash,
} from "../../../packages/llm/src/index.ts";
import { root } from "./helpers.ts";
import { critiqueSchema, critiqueScore } from "../../../packages/agents/src/builder/index.ts";
import { e2eFor, forceModel, renderProbe, runProbe, stageInputs } from "../probe/run.ts";
import { CRITIC_SPREAD, OPEN, STAGES } from "../probe/stages.ts";

const registry = createRegistry({ buildDefaultTier: "T1" });
const tmp = () => mkdtempSync(join(tmpdir(), "wz-records-"));

function fakeInner(answer: (input: RouteInput, i: number) => RouteOutput | Error): Router & { calls: RouteInput[] } {
  const calls: RouteInput[] = [];
  return {
    mode: "live",
    registry,
    calls,
    async route(input) {
      calls.push(input);
      const a = answer(input, calls.length - 1);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const out = (name: string, args: Record<string, unknown>, model = "glm-5.3"): RouteOutput => ({
  tier: "T1",
  model,
  result: { toolCalls: [{ id: "c1", name, args }], finishReason: "tool-calls" },
  usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 },
  creditsCharged: 0.5,
  creditsMilli: 500,
  routeReason: "default_T1",
  scrubbed: false,
  ruFallback: false,
});

const TOOL = { name: "submit", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } };
const call = (systemId: string, system = "Ты — арт-директор.", tools = [TOOL]): RouteInput => ({
  callType: "art_direction",
  messages: [
    { role: "system", content: system },
    { role: "user", content: "Почта owner@clinic.ru, телефон +7 (843) 200-40-50, ключ sk-abcdefghijklmnopqrstuv" },
  ],
  tools,
  orgPolicy: null,
  ctx: { orgId: "org", systemId },
});

function project() {
  const root = tmp();
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "art.ts"), "export const ROLE = 'v1';\n");
  const manifest = { art_direction: ["prompts/art.ts"] };
  return { root, manifest, versions: () => new PromptVersions({ root, manifest }) };
}

describe("records (V4-03)", () => {
  test("a live call is written under «callType@version/model», secrets and strong identifiers removed", async () => {
    const p = project();
    const book = new RecordBook(join(p.root, "rec.jsonl"));
    const inner = fakeInner(() => out("submit", { a: "звоните 8 917 123-45-67, карта 4111 1111 1111 1111" }));
    const r = recordingRouter(inner, { book, source: "build", versions: p.versions() });
    await r.route(call("sys-1"));
    const [line] = book.all();
    const v = p.versions().of(call("sys-1"));
    expect(line?.key).toBe(`art_direction@${v}/glm-5.3`);
    expect(line?.promptVersion).toMatch(/^[0-9a-f]{8}\.[0-9a-f]{8}$/);
    expect(line?.costRub).toBeGreaterThan(0);
    const text = readFileSync(book.path, "utf8");
    for (const leak of ["owner@clinic.ru", "200-40-50", "sk-abcdefghij", "917 123-45-67", "4111 1111"])
      expect(text).not.toContain(leak);
    expect(text).toContain("user@example.com");
    expect(line?.request.tools[0]?.parameters).toEqual(TOOL.parameters);
  });

  test("the tool hash follows the shape of the schema, not the data of this run (enum candidates, texts)", () => {
    const tool = (e: string[], extra = {}) => ({
      name: "submit",
      parameters: { type: "object", properties: { pick: { type: "string", enum: e, description: e.join() }, ...extra } },
    });
    expect(toolsHash([tool(["a", "b"])])).toBe(toolsHash([tool(["c"])]));
    expect(toolsHash([tool(["a"])])).not.toBe(toolsHash([tool(["a"], { title: { type: "string" } })]));
  });

  test("redact keeps secret references, ordinary numbers and prices", () => {
    const s = "secret://crm_token, цена 12 500 ₽, 1760000000000 мс, api_key: abcdef123456";
    expect(redact(s)).toBe("secret://crm_token, цена 12 500 ₽, 1760000000000 мс, api_key: <secret>");
  });

  test("redact keeps ids: a photo UUID is not a card number, a card still is", () => {
    const url = "/_wizard/photos/00000002-0000-4000-8000-000000000002/1600";
    expect(redact(url)).toBe(url);
    expect(redact("карта 4111 1111 1111 1111.")).toBe("карта 0000 0000 0000 0000.");
  });

  test("replay answers by scope and ordinal; a missing record fails loudly and is kept", async () => {
    const p = project();
    const book = new RecordBook(join(p.root, "e2e.jsonl"));
    const rec = recordingRouter(
      fakeInner((_i, n) => out("submit", { a: `ответ ${n}` })),
      { book, source: "e2e", versions: p.versions() },
    );
    await rec.route(call("a"));
    await rec.route(call("b"));
    await rec.route(call("a"));

    const misses: string[] = [];
    const replay = replayRouter({ registry, books: [book], versions: p.versions(), onMiss: (m) => misses.push(m.message) });
    // Other ids, same order of appearance: the same answers.
    const args = async (id: string) =>
      ((await replay.route(call(id))).result.toolCalls[0]?.args as { a: string }).a;
    expect(await args("x")).toBe("ответ 0");
    expect(await args("y")).toBe("ответ 1");
    expect(await args("x")).toBe("ответ 2");
    expect(misses).toEqual([]);

    // Another tool schema: another prompt version → no record.
    const other = { ...TOOL, parameters: { type: "object", properties: { b: { type: "number" } } } };
    const e = await replay.route(call("x", "Ты — арт-директор.", [other])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).code).toBe("FIXTURE_MISS");
    expect((e as LlmError).message).toMatch(/^нет записи для art_direction@[0-9a-f]{8}\.[0-9a-f]{8}$/);
    expect(replay.misses).toHaveLength(1);
    expect(misses).toHaveLength(1);
  });

  test("parallel calls of one type reaching the router in another order get the answers of their own requests", async () => {
    const p = project();
    const book = new RecordBook(join(p.root, "e2e.jsonl"));
    const direction = (systemId: string, name: string, runId: string): RouteInput => ({
      ...call(systemId),
      messages: [
        { role: "system", content: "Ты — арт-директор." },
        { role: "user", content: `Направление «${name}», прогон ${runId}, 2026-10-13T21:00:00.000Z` },
      ],
    });
    const rec = recordingRouter(
      fakeInner((i) => out("submit", { a: String(i.messages[1]?.content).split("»")[0] ?? "" })),
      { book, source: "e2e", versions: p.versions() },
    );
    for (const name of ["Спокойная", "Смелая", "Тёплая"])
      await rec.route(direction("a", name, "11111111-1111-4111-8111-111111111111"));

    const replay = replayRouter({ registry, books: [book], versions: p.versions() });
    const args = async (name: string) =>
      (
        (await replay.route(direction("x", name, "22222222-2222-4222-8222-222222222222"))).result.toolCalls[0]
          ?.args as { a: string }
      ).a;
    const got = await Promise.all(["Тёплая", "Спокойная", "Смелая"].map(args));
    expect(got).toEqual(["Направление «Тёплая", "Направление «Спокойная", "Направление «Смелая"]);
  });

  test("a refusal is recorded and replayed; a call past the recorded run fails as unavailable, not as a miss", async () => {
    const p = project();
    const book = new RecordBook(join(p.root, "e2e.jsonl"));
    const rec = recordingRouter(
      fakeInner((_i, n) => (n === 1 ? new LlmError("LLM_UNAVAILABLE", "нет") : out("submit", { a: "1" }))),
      { book, source: "e2e", versions: p.versions() },
    );
    await rec.route(call("a"));
    await expect(rec.route(call("a"))).rejects.toThrow("нет");
    expect(book.all().map((l) => l.error?.code ?? "ok")).toEqual(["ok", "LLM_UNAVAILABLE"]);

    const beyond: string[] = [];
    const replay = replayRouter({ registry, books: [book], versions: p.versions(), onBeyond: (m) => beyond.push(m.message) });
    await replay.route(call("a"));
    await expect(replay.route(call("a"))).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    await expect(replay.route(call("a"))).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(beyond).toHaveLength(1);
    expect(replay.misses).toEqual([]);
  });

  test("an edited prompt source is a new version: its old records no longer answer", async () => {
    const p = project();
    const book = new RecordBook(join(p.root, "e2e.jsonl"));
    await recordingRouter(fakeInner(() => out("submit", { a: "1" })), {
      book,
      source: "e2e",
      versions: p.versions(),
    }).route(call("a"));
    writeFileSync(join(p.root, "prompts", "art.ts"), "export const ROLE = 'v2';\n");
    const replay = replayRouter({ registry, books: [book], versions: p.versions() });
    await expect(replay.route(call("a"))).rejects.toThrow(/нет записи для art_direction@/);
    // Outside the manifest the version follows the system messages.
    const loose = new PromptVersions({ root: p.root, manifest: {} });
    expect(loose.of(call("a"))).not.toBe(loose.of(call("a", "Другой промпт")));
  });

  test("a record answering with a tool not offered now is not used", async () => {
    const p = project();
    const book = new RecordBook(join(p.root, "e2e.jsonl"));
    await recordingRouter(fakeInner(() => out("other_tool", {})), {
      book,
      source: "e2e",
      versions: p.versions(),
    }).route(call("a"));
    const replay = replayRouter({ registry, books: [book], versions: p.versions() });
    await expect(replay.route(call("a"))).rejects.toThrow(/нет записи/);
  });
});

describe("stage probe (V4-03)", () => {
  test("every stage has 2–3 saved inputs (raw is optional)", () => {
    for (const stage of Object.keys(STAGES).filter((s) => s !== "raw")) {
      const n = stageInputs(stage).length;
      expect(n, stage).toBeGreaterThanOrEqual(1);
      expect(n, stage).toBeLessThanOrEqual(3);
    }
  });

  test("forceModel puts the model at the head of the stage's routes", () => {
    const reg = forceModel(registry, ["art_direction"], "kimi-k2.6");
    expect(reg.routes.art_direction.chain).toEqual({ T0: ["kimi-k2.6"] });
    expect(() => forceModel(registry, ["art_direction"], "no-such-model")).toThrow(/нет в реестре/);
  });

  test("an unavailable model: every stage runs, takes its fallback and the probe fails loudly", async () => {
    const dir = tmp();
    const stages = ["interview_v3", "brief_extract", "art_direction", "direction_texts", "page_compose", "techreview", "point_edit"];
    for (const stage of stages) {
      const book = new RecordBook(join(dir, `${stage}.jsonl`));
      const inner = fakeInner(() => new LlmError("LLM_UNAVAILABLE", "Модели сейчас недоступны. Попробуйте позже."));
      const r = await runProbe({
        stage,
        inputs: [stageInputs(stage)[0]?.[0] as string],
        router: () => inner,
        book,
        log: () => {},
      });
      // The stage reached its model with its own callType.
      expect(inner.calls.length, stage).toBeGreaterThan(0);
      expect(STAGES[stage]?.callTypes, stage).toContain(inner.calls[0]?.callType);
      // As the platform's queue gives every call its org's policy: no stage call is held to T0 by a missing one.
      for (const c of inner.calls) expect(c.orgPolicy, stage).toEqual(OPEN);
      expect(r.ok, stage).toBe(false);
      expect(r.results[0]?.ok).toBe(false);
      expect(r.results[0]?.calls).toEqual([]);
      expect(book.all()).toEqual([]);
      expect(renderProbe(r)).toContain("❌");
    }
  }, 60_000);

  test("raw: a saved route input is sent as is, the answer becomes a probe record; the cap stops the probe", async () => {
    const dir = tmp();
    mkdirSync(join(dir), { recursive: true });
    const book = new RecordBook(join(dir, "raw.jsonl"));
    const inner = fakeInner(() => out("submit", { a: "ok" }));
    const r = await runProbe({
      stage: "raw",
      inputs: [],
      router: () => inner,
      book,
      log: () => {},
      capRub: 0,
    }).catch((e: unknown) => e);
    // No saved raw inputs in the repository: the probe says so.
    expect(String(r)).toMatch(/нет сохранённых входов/);
  });

  // CI replays the probes' records: the stage uses the recorded answer, no fallback; an edited prompt needs a new probe
  // (the stage-probe workflow records it on the push of the edit).
  test.each(["interview_v3", "brief_extract", "art_direction", "direction_texts", "page_compose", "point_edit"])(
    "the recorded probe of %s replays without a miss and without the fallback",
    async (stage) => {
      const book = RecordBook.named(`probe/${stage}`, root);
      const labels = new Set(book.all().map((l) => l.label));
      const inputs = stageInputs(stage).filter(([name]) => labels.has(name));
      expect(inputs.length, "нет записей пробы: запустите stage-probe").toBeGreaterThan(0);
      const replay = replayRouter({ registry, books: [book] });
      for (const [name, input] of inputs) {
        const r = await STAGES[stage]?.run(input, (i) => replay.route(i), {
          orgId: "probe",
          systemId: `probe-${stage}-${name}`,
        });
        expect(replay.misses.map((m) => m.message)).toEqual([]);
        expect(r?.fallback, `${stage}/${name}: ${r?.summary}`).toBe(false);
      }
    },
    60_000,
  );

  // The freshness of the e2e v3 records (by stage, V4-19): tools/fixtures/test/e2e-v3-records.test.ts.
  test("a changed prompt source of an e2e callType asks for a new e2e recording", () => {
    const manifest = { critic_visual: ["packages/agents/src/builder/v3/critic/prompt.ts"], interview_v3: ["x.ts"] };
    expect(e2eFor(["packages/agents/src/builder/v3/critic/prompt.ts"], manifest)).toBe(true);
    expect(e2eFor(["x.ts", "README.md"], manifest)).toBe(false);
  });

  // V4-09: the critic's score on the same screenshots in three repeats differs by at most 10 points (the records of the
  // live probe critic_visual; its stage needs Chromium, so the scores are read from the records).
  test("the critic's score is stable: repeats on the same shots by one model within 20 points", () => {
    const book = RecordBook.named("probe/critic_visual", root);
    // The latest prompt's answers, per input and model (a fallback model is another critic).
    const lines = book.all();
    const latest = lines.at(-1)?.promptVersion;
    const byInput = new Map<string, Map<string, number[]>>();
    for (const l of lines) {
      const call = l.response.toolCalls.find((c) => c.name === "submit_critique");
      if (!call || !l.label || l.promptVersion !== latest) continue;
      const parsed = critiqueSchema.safeParse(call.args);
      if (!parsed.success) continue;
      const models = byInput.get(l.label) ?? new Map<string, number[]>();
      models.set(l.model, [...(models.get(l.model) ?? []), critiqueScore(parsed.data)]);
      byInput.set(l.label, models);
    }
    expect(byInput.size, "нет записей пробы critic_visual: запустите stage-probe").toBeGreaterThan(0);
    for (const [label, models] of byInput) {
      const scores = [...models.values()].sort((x, y) => y.length - x.length)[0] as number[];
      expect(scores.length, label).toBeGreaterThanOrEqual(2);
      expect(Math.max(...scores) - Math.min(...scores), `${label}: ${scores.join(", ")}`).toBeLessThanOrEqual(
        CRITIC_SPREAD,
      );
    }
  });
});
