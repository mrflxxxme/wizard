// biome-ignore-all lint/suspicious/noExplicitAny: assertions over untyped fixture JSON (tool args)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type AppSpec,
  applyOps,
  emptySpec,
  scenarioStepSchema,
  validateSpec,
} from "../../../packages/appspec/src/index.ts";
import { detect } from "../../../packages/pii/src/index.ts";
import { canonicalRequest, fixtureKey } from "../lib/format.mjs";
import { buildGolden, loadYaml, TOOLSETS } from "../lib/golden.mjs";
import { OWNER_ONLY_COMPLIANCE_FIELDS } from "../lib/spec-to-ops.mjs";
import { genGolden, root, unordered } from "./helpers.ts";

type ToolCall = { id: string; name: string; args: Record<string, any> };
type Line = {
  v: number;
  key: string;
  callType: string;
  modelId: string;
  request: {
    messages: unknown[];
    tools: { name: string; schemaHash: string }[];
    params: Record<string, number>;
  };
  response: { text?: string; toolCalls: ToolCall[]; finishReason: string };
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number };
  latencyMs: number;
  recordedAt: string;
};

const [orchestrator, models] = loadYaml(
  join(root, "specs/agents/orchestrator.yaml"),
  join(root, "specs/agents/models.yaml"),
);
const allowlist = new Set(
  readFileSync(join(root, "tools/eval/pii-allowlist.txt"), "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#")),
);

const tmp = mkdtempSync(join(tmpdir(), "wizard-golden-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** security/abuse.yaml#patterns.secrets + auth headers. */
function secretFindings(text: string): string[] {
  const out: string[] = [];
  const res = [
    /live_[A-Za-z0-9_-]{20,}/g,
    /\d{8,10}:[A-Za-z0-9_-]{35}/g,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:authorization|bearer|x-api-key|api[_-]?key)\b\s*[:=]/gi,
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.push(m[0]);
  const entropy = (s: string) => {
    const freq = new Map<string, number>();
    for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
    return [...freq.values()].reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
  };
  for (const m of text.matchAll(/key|token|secret|пароль|password/gi)) {
    const window = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    for (const w of window.matchAll(/[A-Za-z0-9+/=_-]{24,}/g))
      if (!w[0].startsWith("secret://") && entropy(w[0]) >= 4.0) out.push(w[0]);
  }
  return out;
}

/** Golden demo transcripts (specs/quality/eval.yaml#fixtures.golden): M0-21 forum, M0-22 bakery. */
describe.each(["forum", "bakery"])("golden %s", (name) => {
const fixturePath = join(root, "tools/fixtures/demo", `${name}.jsonl`);
const goldenPath = join(root, "tools/fixtures/golden", `${name}.yaml`);
const fixtureText = readFileSync(fixturePath, "utf8");
const lines: Line[] = fixtureText
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l));
const g = buildGolden(name, { root });
const calls = (callType: string) => lines.filter((l) => l.callType === callType);
const toolArgs = (callType: string, i = 0) => (calls(callType)[i]?.response.toolCalls[0]?.args ?? {}) as any;

describe("gen-golden", () => {
  it("детерминирован: два запуска байт-в-байт и совпадают с закоммиченной фикстурой", () => {
    const a = genGolden(name, `--out=${join(tmp, `${name}-a.jsonl`)}`);
    const b = genGolden(name, `--out=${join(tmp, `${name}-b.jsonl`)}`);
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    const ta = readFileSync(join(tmp, `${name}-a.jsonl`), "utf8");
    expect(readFileSync(join(tmp, `${name}-b.jsonl`), "utf8")).toBe(ta);
    expect(ta).toBe(fixtureText);
    expect(genGolden(name, "--check").status).toBe(0);
  });

  it("порядок callType: interview, interview, card, plan, build_ops×N, build_code×M, qa_generate", () => {
    const order = lines.map((l) => l.callType).join(",");
    expect(order).toMatch(/^interview,interview,card,plan,(build_ops,)+(build_code,)+qa_generate$/);
    expect(g.lines.length).toBe(lines.length);
  });

  it("pii.detect = 0 (кроме синтетики из tools/eval/pii-allowlist.txt), в том числе в golden yaml", () => {
    for (const s of allowlist) expect(s).toMatch(/^[a-z0-9]+@example\.test$/);
    const texts = [fixtureText, readFileSync(goldenPath, "utf8"), ...lines.flatMap((l) => strings(l))];
    const leaks = texts.flatMap((t) =>
      detect(t)
        .map((f) => t.slice(f.start, f.end))
        .filter((v) => !allowlist.has(v)),
    );
    expect(leaks).toEqual([]);
  });

  it("поиск секретов = 0; ссылки на секреты только secret://", () => {
    expect(secretFindings(fixtureText)).toEqual([]);
    expect(secretFindings(readFileSync(goldenPath, "utf8"))).toEqual([]);
    for (const s of strings(g.buildSpec.integrations))
      if (/secret/i.test(s)) expect(s).toMatch(/^secret:\/\/[a-z0-9_]+$/);
  });

  it("строки фикстуры по формату eval.yaml#fixtures.line", () => {
    const ids = new Set<string>();
    for (const l of lines) {
      expect(Object.keys(l)).toEqual([
        "v",
        "key",
        "callType",
        "modelId",
        "request",
        "response",
        "usage",
        "latencyMs",
        "recordedAt",
      ]);
      expect(l.v).toBe(1);
      expect(l.key).toBe(fixtureKey(l));
      expect(l.key).toMatch(/^[0-9a-f]{64}$/);
      const route = models.routes[l.callType];
      expect(route).toBeDefined();
      expect(l.modelId).toBe(route.chain.T1[0]);
      expect(l.request.params).toEqual({ temperature: route.temperature, max_tokens: route.max_tokens });
      expect(l.response.finishReason).toBe(l.response.toolCalls.length ? "tool-calls" : "stop");
      expect(l.response.toolCalls.length).toBeLessThanOrEqual(8);
      const offered = l.request.tools.map((t) => t.name);
      for (const tc of l.response.toolCalls) {
        expect(offered).toContain(tc.name);
        expect(ids.has(tc.id)).toBe(false);
        ids.add(tc.id);
      }
      expect(l.usage.promptTokens).toBeGreaterThan(0);
      expect(l.usage.completionTokens).toBeGreaterThan(0);
      expect(l.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    for (const ct of ["build_ops", "build_code"])
      expect(calls(ct).at(-1)?.response.finishReason).toBe("stop");
    expect(calls("build_ops")[0]?.request.tools.map((t) => t.name)).toEqual(TOOLSETS.build);
  });

});

describe("оркестратор: Analysis, вопросы, карточка", () => {
  const forkIds = new Set(
    Object.values(orchestrator.fork_taxonomy as Record<string, unknown>)
      .filter(Array.isArray)
      .flat()
      .map((f: any) => f.id),
  );

  it("submit_analysis по схеме orchestrator.yaml#schemas.Analysis", () => {
    const a = toolArgs("interview", 0);
    expect(calls("interview")[0]?.response.toolCalls[0]?.name).toBe("submit_analysis");
    expect(a.goals.length).toBeGreaterThanOrEqual(1);
    expect(a.goals.length).toBeLessThanOrEqual(5);
    expect(["events", "made_to_order", "horizontal"]).toContain(a.segment);
    expect(a.roles.length).toBeLessThanOrEqual(8);
    expect(a.entities.length).toBeLessThanOrEqual(20);
    for (const e of a.entities) expect(e.keyFields.length).toBeLessThanOrEqual(8);
    for (const r of [...a.resolved, ...a.unknowns.map((forkId: string) => ({ forkId }))])
      expect(forkIds).toContain(r.forkId);
  });

  it("ask_questions: 3–7 вопросов, развилки из таксономии, ровно один recommended", () => {
    const { questions } = toolArgs("interview", 1);
    expect(questions.length).toBeGreaterThanOrEqual(3);
    expect(questions.length).toBeLessThanOrEqual(7);
    for (const [i, q] of questions.entries()) {
      expect(q.id).toBe(`q${i + 1}`);
      expect(forkIds).toContain(q.forkId);
      expect(q.text.length).toBeLessThanOrEqual(140);
      expect(q.whyItMatters.length).toBeLessThanOrEqual(160);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.options.length).toBeLessThanOrEqual(4);
      expect(q.options.filter((o: any) => o.recommended).length).toBe(1);
      for (const o of q.options) expect(o.label.length).toBeLessThanOrEqual(60);
      const ans = g.golden.answers.find((x: any) => x.questionId === q.id);
      expect(q.options.map((o: any) => o.id)).toContain(ans.optionId);
      if (ans.byRecommendation)
        expect(q.options.find((o: any) => o.id === ans.optionId).recommended).toBe(true);
    }
  });

  it("submit_card: семантика S5_card (роли в AC, AC на каждую роль с входом, id AC1..ACn, без phone_otp)", () => {
    const card = toolArgs("card");
    for (const k of ["estimate", "cap", "cardVersion"]) expect(card[k]).toBeUndefined();
    expect(card.title.length).toBeLessThanOrEqual(80);
    expect(card.summary.length).toBeLessThanOrEqual(400);
    const roles = new Set(card.roles.map((r: any) => r.name));
    const entities = new Set(card.data.map((d: any) => d.name));
    expect(card.acceptance.length).toBeGreaterThanOrEqual(3);
    expect(card.acceptance.map((a: any) => a.id)).toEqual(
      card.acceptance.map((_: unknown, i: number) => `AC${i + 1}`),
    );
    for (const a of card.acceptance) {
      expect(a.text.length).toBeLessThanOrEqual(200);
      if (a.check.role) expect(roles).toContain(a.check.role);
      if (a.check.entity) expect(entities).toContain(a.check.entity);
    }
    for (const r of card.roles) {
      if (r.access === "login") expect(card.acceptance.some((a: any) => a.check.role === r.name)).toBe(true);
      expect(r.loginMethods ?? []).not.toContain("phone_otp");
      expect(r.can.length).toBeLessThanOrEqual(8);
    }
    for (const d of card.data) expect(d.fields.length).toBeLessThanOrEqual(12);
    expect(card.pii.consent).toBe(true);
    for (const e of g.buildSpec.entities.filter((e: any) =>
      e.fields.some((f: any) => (f.pii ?? "none") !== "none"),
    ))
      expect(card.pii.retention.map((r: any) => r.entity)).toContain(e.name);
    expect(card.forkAnswers).toEqual(g.golden.answers);
  });
});

describe("строитель: план, apply_ops, write_file", () => {
  it("submit_plan ≤ 20 шагов P1..Pn, acRefs из карточки", () => {
    const { steps } = toolArgs("plan");
    const acIds = new Set(g.card.acceptance.map((a: any) => a.id));
    expect(steps.length).toBeLessThanOrEqual(20);
    for (const [i, s] of steps.entries()) {
      expect(s.id).toBe(`P${i + 1}`);
      for (const ac of s.acRefs) expect(acIds).toContain(ac);
    }
  });

  it("apply_ops батчами ≤ 50 от агента: каждый батч применяется, итог = golden-спека", () => {
    const batches = calls("build_ops").filter((l) => l.response.toolCalls.length);
    let spec: AppSpec = emptySpec(g.spec.app.name);
    spec.app.template = g.spec.app.template;
    for (const [i, l] of batches.entries()) {
      const [tc] = l.response.toolCalls;
      expect(tc?.name).toBe("apply_ops");
      expect(tc?.args.expectedVersion).toBe(i);
      expect(tc?.args.ops.length).toBeLessThanOrEqual(50);
      const r = applyOps(spec, tc?.args.ops, tc?.args.expectedVersion, {
        currentVersion: i,
        author: "agent",
      });
      if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 1));
      spec = r.spec;
    }
    expect(validateSpec(spec).ok).toBe(true);
    const want = structuredClone(g.buildSpec);
    for (const k of OWNER_ONLY_COMPLIANCE_FIELDS) delete want.compliance?.[k];
    expect(unordered(spec)).toEqual(unordered(want));
    expect(spec.acceptance).toEqual(g.card.acceptance);
  });

  it("write_file: пути по правилам builder.yaml, functions/** раньше ui/**, покрыты все файлы спеки, затем run_gate G0", () => {
    const tcs = calls("build_code").flatMap((l) => l.response.toolCalls);
    const writes = tcs.filter((t) => t.name === "write_file");
    const paths = writes.map((t) => t.args.path as string);
    for (const t of writes) {
      expect(t.args.path).toMatch(/^(ui\/[A-Za-z0-9_/-]+\.tsx|functions\/[A-Za-z0-9_/-]+\.ts)$/);
      expect(t.args.content.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(t.args.content)).toBeLessThanOrEqual(48 * 1024);
      expect(t.args.content).toBe(readFileSync(join(root, g.golden.code_root, t.args.path), "utf8"));
    }
    expect(paths.findIndex((p) => p.startsWith("ui/"))).toBeGreaterThan(
      paths.findLastIndex((p) => p.startsWith("functions/")),
    );
    for (const f of [...(g.buildSpec.functions ?? []), ...(g.buildSpec.pages ?? [])])
      expect(paths).toContain(f.file);
    expect(tcs.at(-1)).toMatchObject({ name: "run_gate", args: { level: "G0" } });
  });
});

describe("QA: submit_checks", () => {
  it("SC на каждый AC scenario|constraint ≤ M0; шаги по DSL; роли, функции и переменные существуют", () => {
    const { checks } = toolArgs("qa_generate");
    const spec = g.buildSpec;
    const due = g.card.acceptance.filter(
      (a: any) => a.check.type !== "permission" && (a.check.milestone ?? "M0") === "M0",
    );
    expect(checks.map((c: any) => c.acId)).toEqual(due.map((a: any) => a.id));
    const roles = new Set(spec.roles.map((r: any) => r.name));
    const fns = new Set((spec.functions ?? []).map((f: any) => f.name));
    const entities = new Set(spec.entities.map((e: any) => e.name));
    for (const c of checks) {
      expect(c.id).toBe(`SC-${c.acId}`);
      for (const a of Object.values(c.actors) as any[]) expect(roles).toContain(a.role);
      expect(c.steps.some((s: any) => "expect" in s)).toBe(true);
      const vars = new Set(Object.keys(c.actors));
      for (const s of c.steps) {
        expect(scenarioStepSchema.safeParse(s).success).toBe(true);
        for (const v of strings(s)) {
          const m = /^\$([a-z][a-z0-9_]*)\./i.exec(v);
          if (m && m[1] !== "seed" && m[1] !== "now") expect(vars).toContain(m[1]);
        }
        const act = s.create ?? s.read ?? s.update ?? s.delete;
        if (act) expect(entities).toContain(act.entity);
        if (s.callFn) expect(fns).toContain(s.callFn.name);
        const save = (s.create ?? s.read ?? s.update ?? s.callFn)?.save;
        if (save) vars.add(save);
      }
    }
  });
});
});

describe("fixture key", () => {
  it("canonical key: uuid → <uuid:N>, даты → <date>, пробелы в конце строк, runId", () => {
    const line = (content: string) => ({
      callType: "fix",
      modelId: "glm-5.3",
      request: {
        messages: [{ role: "user", content }],
        tools: [],
        params: { temperature: 0.1, max_tokens: 10 },
      },
    });
    const u1 = "0b7e4c1a-1111-4a2b-8c3d-000000000001";
    const u2 = "0b7e4c1a-2222-4a2b-8c3d-000000000002";
    const a = line(`run r-1 ${u1} ${u2} ${u1} 2026-09-30T10:00:00Z  \nok`);
    const b = line(`run r-2 ${u2.toUpperCase()} ${u1} ${u2} 2027-01-01\nok`);
    expect(canonicalRequest(a, { runId: "r-1" })).toBe(canonicalRequest(b, { runId: "r-2" }));
    expect(canonicalRequest(a, { runId: "r-1" })).toContain("<runId> <uuid:1> <uuid:2> <uuid:1> <date>\\nok");
    expect(fixtureKey(a)).not.toBe(fixtureKey(line("other")));
  });
});
