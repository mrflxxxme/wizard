// Golden demo transcript: tools/fixtures/golden/<name>.yaml + specs/appspec/examples/<name>.json + code → fixture lines
// (specs/quality/eval.yaml#fixtures.golden). Deterministic: no clock, no randomness, no network.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { estimateTokens, FIXTURE_VERSION, fixtureKey } from "./format.mjs";
import { batchOps, specToOps } from "./spec-to-ops.mjs";

/** Tools the harness offers per call (names only are compared for suite=demo, eval.yaml#fixtures.lookup). */
export const BUILDER_TOOLS = [
  "apply_ops",
  "write_file",
  "read_file",
  "list_files",
  "run_gate",
  "get_ui_kit_docs",
  "get_sdk_docs",
  "ask_orchestrator",
];
export const TOOLSETS = {
  analysis: ["submit_analysis"],
  questions: ["ask_questions"],
  card: ["submit_card"],
  plan: ["submit_plan"],
  build: BUILDER_TOOLS,
  qa_generate: ["submit_checks"],
};
/** schemaHash is not compared for suite=demo; golden lines carry this marker instead of a real zod schema hash. */
export const GOLDEN_SCHEMA_HASH = "golden";

const MILESTONES = ["M0", "M1", "M2", "M3", "M4"];
const FIELD_KIND = {
  string: "text",
  text: "text",
  url: "text",
  json: "text",
  int: "number",
  decimal: "number",
  money: "money",
  date: "date",
  datetime: "date",
  enum: "choice",
  bool: "choice",
  ref: "link",
  file: "file",
  email: "contact",
  phone: "contact",
  qr_token: "qr",
};

const PY_YAML = `
import sys, json, yaml
out = [yaml.safe_load(open(p, encoding="utf-8")) for p in sys.argv[1:]]
print(json.dumps(out, ensure_ascii=False, default=str))
`;

export function loadYaml(...paths) {
  const r = spawnSync("python3", ["-c", PY_YAML, ...paths], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`YAML (python3 + PyYAML): ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}

function pointer(path) {
  return path
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** RFC 6902 subset (add, replace, remove); throws if a path does not exist. */
export function applyPatch(doc, patch) {
  for (const p of patch ?? []) {
    const keys = pointer(p.path);
    const last = keys.pop();
    let node = doc;
    for (const k of keys) {
      if (node == null || !(k in node)) throw new Error(`spec_patch: нет пути ${p.path}`);
      node = node[k];
    }
    if (p.op !== "add" && !(last in node)) throw new Error(`spec_patch: нет пути ${p.path}`);
    if (p.op === "remove") {
      if (Array.isArray(node)) node.splice(Number(last), 1);
      else delete node[last];
    } else if (p.op === "add" && Array.isArray(node)) {
      node.splice(last === "-" ? node.length : Number(last), 0, structuredClone(p.value));
    } else if (p.op === "add" || p.op === "replace") node[last] = structuredClone(p.value);
    else throw new Error(`spec_patch: неизвестная операция ${p.op}`);
  }
  return doc;
}

/**
 * Replaces whole string values matching a rule ({pattern?, key?, with}: value regex and/or property-name regex);
 * {n} numbers distinct matched values per rule in order of appearance.
 */
function synthesizer(rules) {
  const compiled = (rules ?? []).map((r) => ({
    re: r.pattern === undefined ? null : new RegExp(r.pattern, "u"),
    key: r.key === undefined ? null : new RegExp(r.key, "u"),
    with: r.with,
    seen: new Map(),
  }));
  const walk = (v, key) => {
    if (typeof v === "string") {
      const r = compiled.find(
        (c) => (!c.re || c.re.test(v)) && (!c.key || (key !== undefined && c.key.test(key))),
      );
      if (!r) return v;
      if (!r.seen.has(v)) r.seen.set(v, r.with.replaceAll("{n}", String(r.seen.size + 1)));
      return r.seen.get(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk;
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

function need(cond, msg) {
  if (!cond) throw new Error(`golden: ${msg}`);
}

function deriveEntities(spec) {
  return spec.entities.map((e) => ({
    name: e.name,
    label: e.label,
    keyFields: e.fields.slice(0, 8).map((f) => f.name),
    containsPii: e.fields.some((f) => (f.pii ?? "none") !== "none"),
  }));
}

function deriveCard(g, spec) {
  const c = g.card;
  const byName = (map, what, name) => {
    need(map?.[name] !== undefined, `в card.${what} нет «${name}»`);
    return map[name];
  };
  const piiFields = spec.entities.flatMap((e) =>
    e.fields
      .filter((f) => (f.pii ?? "none") !== "none")
      .map((f) => ({ entity: e.name, field: f.name, category: f.piiKind ?? "other" })),
  );
  return {
    title: c.title,
    summary: c.summary,
    segment: c.segment,
    roles: spec.roles.map((r) => {
      const t = byName(c.roles, "roles", r.name);
      return {
        name: r.name,
        label: r.label,
        access: r.access,
        ...(r.loginMethods ? { loginMethods: r.loginMethods } : {}),
        description: t.description,
        can: t.can,
      };
    }),
    data: spec.entities.map((e) => ({
      name: e.name,
      label: e.label,
      fields: e.fields.slice(0, 12).map((f) => ({ label: f.label, kind: FIELD_KIND[f.type] ?? "text" })),
      pii: e.fields.some((f) => (f.pii ?? "none") !== "none") ? "basic" : "none",
    })),
    specVsCode: c.specVsCode,
    screens: (spec.pages ?? []).map((p) => ({
      route: p.route,
      title: p.title,
      roles: p.roles,
      purpose: byName(c.screens, "screens", p.route),
    })),
    integrations: (spec.integrations ?? []).map((i) => ({
      connector: i.connector,
      ...byName(c.integrations, "integrations", i.name),
    })),
    automations: (spec.workflows ?? []).map((w) => ({
      name: w.label ?? w.name,
      ...byName(c.automations, "automations", w.name),
    })),
    acceptance: g.acceptance,
    pii: {
      categories: [...new Set(piiFields.map((f) => f.category))],
      fields: piiFields,
      retention: spec.entities
        .filter((e) => e.retention)
        .map((e) => ({
          entity: e.name,
          deleteAfterDays: e.retention.deleteAfterDays,
          ...(e.retention.anchorField ? { anchorField: e.retention.anchorField } : {}),
          mode: e.retention.mode ?? "delete",
          humanText: byName(c.pii?.retention, "pii.retention", e.name),
        })),
      consent: piiFields.length > 0,
      summary: c.pii.summary,
    },
    assumptions: c.assumptions ?? [],
    outOfScope: c.outOfScope ?? [],
    forkAnswers: g.answers,
  };
}

function deriveScenarios(g, spec) {
  const upTo = MILESTONES.indexOf(g.qa?.milestone ?? "M0");
  const synth = synthesizer(g.qa?.replace);
  const source = new Map((spec.acceptance ?? []).map((a) => [a.id, a]));
  return g.acceptance
    .filter((a) => a.check.type !== "permission" && MILESTONES.indexOf(a.check.milestone ?? "M0") <= upTo)
    .map((a) => {
      const check = source.get(a.id)?.check;
      need(check?.steps?.length, `у ${a.id} в спеке нет steps для сценария QA`);
      return synth({
        id: `SC-${a.id}`,
        acId: a.id,
        title: a.text,
        actors: check.actors ?? {},
        ...(check.seed ? { seed: check.seed } : {}),
        steps: check.steps,
      });
    });
}

/** push(callType, toolset, messages, response) → appends one fixture line (eval.yaml#fixtures.line) to `lines`. */
function pusher(models, g, lines) {
  const counters = {};
  return (callType, toolset, messages, response) => {
    const route = models.routes[callType];
    need(route, `нет routes.${callType} в models.yaml`);
    counters[callType] = (counters[callType] ?? 0) + 1;
    const n = counters[callType];
    const toolCalls = (response.toolCalls ?? []).map((tc, i) => ({
      id: `call_${callType}_${n}_${i + 1}`,
      ...tc,
    }));
    for (const tc of toolCalls)
      need(TOOLSETS[toolset].includes(tc.name), `${tc.name} не из набора ${toolset}`);
    const base = {
      callType,
      modelId: route.chain.T1?.[0] ?? route.chain.T0[0],
      request: {
        messages,
        tools: TOOLSETS[toolset].map((t) => ({ name: t, schemaHash: GOLDEN_SCHEMA_HASH })),
        params: { temperature: route.temperature, max_tokens: route.max_tokens },
      },
    };
    const resp = {
      ...(response.text ? { text: response.text } : {}),
      toolCalls,
      finishReason: toolCalls.length ? "tool-calls" : "stop",
    };
    const completionTokens = estimateTokens(resp);
    lines.push({
      v: FIXTURE_VERSION,
      key: fixtureKey(base),
      ...base,
      response: resp,
      usage: { promptTokens: estimateTokens(base.request), cachedPromptTokens: 0, completionTokens },
      latencyMs: 400 + completionTokens * 10,
      recordedAt: g.recordedAt,
    });
  };
}

/**
 * «Укажи и измени» (M3-01, agents/builder.yaml#point_and_edit): a mode=point_edit run after the demo build. The first
 * build_code turn writes a file other than target.file (the builder answers TARGET_ONLY), the second writes only
 * target.file (golden point_edit.patch) and runs G0, the third ends the phase; qa_generate repeats the build's
 * checks for G1. Written to demo/<name>.point_edit.jsonl; platform-api reads it for point_edit runs (fixture mode).
 */
function buildPointEdit(g, models, files, qaLine) {
  const pe = g.point_edit;
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const before = byPath.get(pe.target.file);
  need(before !== undefined, `point_edit.target.file ${pe.target.file} нет среди файлов`);
  need(pe.target.file.startsWith("ui/"), "point_edit.target.file — только ui/**");
  need(before.split(pe.patch.find).length === 2, "point_edit.patch.find должен встречаться ровно один раз");
  const after = before.replace(pe.patch.find, pe.patch.replace);
  const stray = byPath.get(pe.stray.path);
  need(stray !== undefined && pe.stray.path !== pe.target.file, "point_edit.stray.path — другой файл системы");
  const lines = [];
  const push = pusher(models, g, lines);
  const user = (content) => ({ role: "user", content });
  const ask = user(`Правка по клику: ${pe.target.file} (${pe.target.componentName}). Задача: ${pe.instruction}`);
  push("build_code", "build", [ask], {
    toolCalls: [{ name: "write_file", args: { path: pe.stray.path, content: stray } }],
  });
  push("build_code", "build", [ask, user("TARGET_ONLY: только target.file")], {
    toolCalls: [
      { name: "write_file", args: { path: pe.target.file, content: after } },
      { name: "run_gate", args: { level: "G0" } },
    ],
  });
  push("build_code", "build", [ask, user("G0 пройден")], { text: pe.done_text });
  push("qa_generate", "qa_generate", qaLine.request.messages, {
    toolCalls: qaLine.response.toolCalls.map(({ name, args }) => ({ name, args })),
  });
  return {
    target: pe.target,
    instruction: pe.instruction,
    stray: pe.stray.path,
    before,
    after,
    lines,
    text: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  };
}

/**
 * @param {string} name golden name (tools/fixtures/golden/<name>.yaml)
 * @param {{root?: string}} [opts] repository root
 */
export function buildGolden(name, opts = {}) {
  const root = resolve(opts.root ?? join(import.meta.dirname, "..", "..", ".."));
  const [g, models] = loadYaml(
    join(root, "tools/fixtures/golden", `${name}.yaml`),
    join(root, "specs/agents/models.yaml"),
  );
  need(g.name === name, `name в yaml ≠ ${name}`);
  const spec = JSON.parse(readFileSync(join(root, g.spec), "utf8"));

  // Spec the builder assembles: patched example + card acceptance; owner-only compliance fields dropped by specToOps.
  const buildSpec = applyPatch(structuredClone(spec), g.build?.spec_patch);
  buildSpec.acceptance = structuredClone(g.acceptance);
  const card = deriveCard(g, buildSpec);
  const scenarios = deriveScenarios(g, spec);
  const batches = batchOps(specToOps(buildSpec, { author: "agent" }));

  const codeRoot = join(root, g.code_root);
  const files = ["functions", "ui"].flatMap((d) =>
    listFiles(join(codeRoot, d)).map((p) => ({
      path: relative(codeRoot, p).split(sep).join("/"),
      content: readFileSync(p, "utf8"),
    })),
  );
  const paths = new Set(files.map((f) => f.path));
  for (const f of [...(buildSpec.functions ?? []), ...(buildSpec.pages ?? [])])
    need(paths.has(f.file), `нет исходника ${f.file} в ${g.code_root}`);

  const lines = [];
  const push = pusher(models, g, lines);
  const user = (content) => ({ role: "user", content });
  const brief = user(g.brief);

  // Orchestrator: analysis → questions → card (orchestrator.yaml#algorithm S2, S4, S5).
  push("interview", "analysis", [brief], {
    toolCalls: [{ name: "submit_analysis", args: { ...g.analysis, entities: deriveEntities(buildSpec) } }],
  });
  push("interview", "questions", [brief, user(`Развилки: ${g.questions.map((q) => q.forkId).join(", ")}`)], {
    toolCalls: [{ name: "ask_questions", args: { questions: g.questions } }],
  });
  const answersText = g.answers
    .map((a) => `${a.questionId}=${a.optionId ?? a.text}${a.byRecommendation ? " (по рекомендации)" : ""}`)
    .join("; ");
  push("card", "card", [brief, user(`Ответы: ${answersText}`)], {
    toolCalls: [{ name: "submit_card", args: card }],
  });

  // Builder: plan → ops batches → code (builder.yaml#loop.phases). A phase ends with a reply without tool calls.
  push("plan", "plan", [user(`Карточка утверждена: «${card.title}», версия 1`)], {
    toolCalls: [{ name: "submit_plan", args: { steps: g.plan } }],
  });
  batches.forEach((ops, i) => {
    push("build_ops", "build", [user(`Фаза ops: батч ${i + 1} из ${batches.length}`)], {
      toolCalls: [{ name: "apply_ops", args: { ops, expectedVersion: i } }],
    });
  });
  const count = (k) => (buildSpec[k] ?? []).length;
  push("build_ops", "build", [user("Фаза ops: все батчи применены")], {
    text: fill(g.build.ops_done_text, {
      roles: count("roles"),
      entities: count("entities"),
      permissions: count("permissions"),
      workflows: count("workflows"),
      integrations: count("integrations"),
    }),
  });
  const perStep = g.build.files_per_step ?? 3;
  const steps = [];
  for (let i = 0; i < files.length; i += perStep) steps.push(files.slice(i, i + perStep));
  steps.forEach((chunk, i) => {
    const toolCalls = chunk.map((f) => ({ name: "write_file", args: { path: f.path, content: f.content } }));
    if (i === steps.length - 1) toolCalls.push({ name: "run_gate", args: { level: "G0" } });
    push("build_code", "build", [user(`Фаза code: шаг ${i + 1} из ${steps.length}`)], { toolCalls });
  });
  push("build_code", "build", [user("Фаза code: G0 пройден")], {
    text: fill(g.build.code_done_text, {
      functions: files.filter((f) => f.path.startsWith("functions/")).length,
      ui: files.filter((f) => f.path.startsWith("ui/")).length,
    }),
  });

  // QA: one submit_checks for every scenario/constraint AC up to the milestone (qa.yaml#checks.from_acceptance).
  push(
    "qa_generate",
    "qa_generate",
    [user(`Критерии для сценариев: ${scenarios.map((s) => s.acId).join(", ")}`)],
    {
      toolCalls: [{ name: "submit_checks", args: { checks: scenarios } }],
    },
  );

  const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  const pointEdit = g.point_edit ? buildPointEdit(g, models, files, lines.at(-1)) : null;
  return { golden: g, spec, buildSpec, card, scenarios, batches, files, lines, text, pointEdit };
}
