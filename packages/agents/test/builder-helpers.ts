// Builder test helpers: golden forum data, bakery script, gate stubs, RunEvent validation against workflows.yaml.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSpec, emptySpec, OWNER_ONLY_COMPLIANCE_FIELDS } from "@wizard/appspec";
import type { Check, GateContext, GateReport } from "@wizard/gates";
import type { LlmResult } from "@wizard/llm";
import postgres from "postgres";
import type { BuildCard, RecordedEvent } from "../src/builder/index.js";
import { loadYaml, ROOT } from "./helpers.js";

export const REPO = new URL(".", ROOT).pathname;

export const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
export const connect = () => postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
export const uniqueKey = (prefix = "m013") => `${prefix}_${randomBytes(4).toString("hex")}`;

interface Golden {
  spec: AppSpec;
  buildSpec: AppSpec;
  card: BuildCard;
  batches: Record<string, unknown>[][];
  files: { path: string; content: string }[];
}

/** tools/fixtures/lib/golden.mjs (M0-21): the golden forum transcript and the spec the builder must assemble. */
export async function golden(name = "forum"): Promise<Golden> {
  const lib = (await import(join(REPO, "tools/fixtures/lib/golden.mjs"))) as {
    buildGolden(name: string, o: { root: string }): Golden;
  };
  return lib.buildGolden(name, { root: REPO });
}

/** Expected result of the golden build: owner-only compliance fields are never set by the agent. */
export function expectedSpec(g: Golden): AppSpec {
  const want = structuredClone(g.buildSpec);
  const c = want.compliance as Record<string, unknown> | undefined;
  if (c) for (const k of OWNER_ONLY_COMPLIANCE_FIELDS) delete c[k];
  return want;
}

/** Start spec of a new system: emptySpec v0 + template (set by the platform at creation, M0-21 notes). */
export function startSpec(spec: AppSpec): AppSpec {
  const s = emptySpec(spec.app.name);
  if (spec.app.template !== undefined) s.app.template = spec.app.template;
  return s;
}

export function unordered(v: unknown): unknown {
  if (Array.isArray(v))
    return v.map(unordered).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, unordered((v as Record<string, unknown>)[k])]),
    );
  return v;
}

export function report(level: "G0" | "G1", passed: boolean, checks: Partial<Check>[] = []): GateReport {
  const full: Check[] = checks.map((c) => ({
    id: c.id ?? level,
    status: c.status ?? (passed ? "pass" : "fail"),
    severity: c.severity ?? "blocker",
    message_ru: c.message_ru ?? "проверка",
    ...(c.file ? { file: c.file } : {}),
    ...(c.line ? { line: c.line } : {}),
  }));
  if (full.length === 0) full.push({ id: level, status: "pass", severity: "blocker", message_ru: "ok" });
  const n = (s: Check["status"]) => full.filter((c) => c.status === s).length;
  return {
    level,
    passed,
    specVersion: 0,
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    checks: full,
    summary: { pass: n("pass"), fail: n("fail"), warn: n("warn"), skip: n("skip"), error: n("error") },
  };
}

/** G1 stub until M0-11: passes when QA handed over checks. */
export const g1Stub = async (ctx: GateContext) => report("G1", Array.isArray(ctx.checks));

/** Minimal card around a spec (roles and acceptance are what the builder reads). */
export function cardFor(spec: AppSpec, acceptance = spec.acceptance ?? []): BuildCard {
  return {
    title: spec.app.name,
    roles: spec.roles.map((r) => ({
      name: r.name,
      label: r.label,
      access: r.access,
      description: r.label,
      can: [],
    })),
    acceptance: acceptance.map((a) => ({
      id: a.id,
      text: a.text,
      check: Object.fromEntries(
        Object.entries(a.check).filter(([k]) =>
          ["type", "role", "entity", "op", "expect", "milestone"].includes(k),
        ),
      ) as BuildCard["acceptance"][number]["check"],
    })),
  };
}

export const tc = (name: string, args: unknown, id = name): LlmResult["toolCalls"][number] => ({
  id,
  name,
  args,
});
export const turn = (...toolCalls: LlmResult["toolCalls"]): LlmResult => ({
  toolCalls,
  finishReason: "tool-calls",
});
export const stop = (text = "Готово."): LlmResult => ({ text, toolCalls: [], finishReason: "stop" });

/** Code files of an example system (specs/runtime/examples[/<dir>]). */
export function exampleFiles(dir = ""): { path: string; content: string }[] {
  const base = join(REPO, "specs/runtime/examples", dir);
  const out: { path: string; content: string }[] = [];
  for (const top of ["functions", "ui"])
    for (const f of readdirSync(join(base, top), { recursive: true, encoding: "utf8" }).sort())
      if (/\.tsx?$/.test(f))
        out.push({
          path: `${top}/${f.split("\\").join("/")}`,
          content: readFileSync(join(base, top, f), "utf8"),
        });
  return out;
}

type EventSchema = { required?: string[]; properties?: Record<string, unknown>; internal?: boolean };
let schemas: Record<string, EventSchema> | undefined;

/** workflows.yaml#events: known type, required payload fields, seq 1..n, one terminal event last. */
export function eventProblems(events: RecordedEvent[], { framed = true } = {}): string[] {
  schemas ??= (
    loadYaml("specs/platform/workflows.yaml") as { events: { types: Record<string, EventSchema> } }
  ).events.types;
  const out: string[] = [];
  events.forEach((e, i) => {
    if (e.seq !== i + 1) out.push(`seq ${e.seq} at ${i}`);
    const s = schemas?.[e.type];
    if (!s) {
      out.push(`unknown event ${e.type}`);
      return;
    }
    for (const k of s.required ?? []) if (e.payload[k] === undefined) out.push(`${e.type}: no ${k}`);
    for (const k of Object.keys(e.payload))
      if (!(k in (s.properties ?? {}))) out.push(`${e.type}: extra ${k}`);
  });
  if (framed) {
    const terminal = events.filter((e) => e.type === "run_finished" || e.type === "run_failed");
    if (terminal.length !== 1 || events.at(-1) !== terminal[0]) out.push("terminal event is not single/last");
  }
  return out;
}
