// V4-03 (D79 (10), docs/plans/2026-10-11-v4.md §5): records of real model answers. Every live call of a founder build or
// a stage probe is written with the key «prompt version + model + tool schema»; CI replays them; a call without a record
// fails loudly («нет записи для <callType>@<версия>») instead of taking a deterministic fallback.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LlmError, type LlmErrorCode } from "../errors.js";
import { findRepoRoot, schemaHash, stableStringify, withoutAttachmentBytes } from "../fixtures.js";
import type { Registry } from "../registry.js";
import type { Router } from "../router.js";
import type { LlmMessage, LlmResult, LlmTool, LlmUsage, RouteInput, RouteOutput, Tier } from "../types.js";

/** Where a record came from: a stage probe, a founder build (prod) or a recorded e2e run. */
export type RecordSource = "probe" | "build" | "e2e";

export interface RecordTool {
  name: string;
  description: string;
  schemaHash: string;
  parameters: Record<string, unknown>;
}

/** One recorded call (a line of tools/fixtures/records/**.jsonl). */
export interface RecordLine {
  v: 2;
  /** `<callType>@<promptVersion>/<model>`. */
  key: string;
  callType: string;
  /** `<prompt sources hash>.<tool schemas hash>` (promptVersion). */
  promptVersion: string;
  model: string;
  tier: Tier;
  source: RecordSource;
  /** Order of first appearance of the system (ctx.systemId, else orgId) in the recording; replay keeps it. */
  scope: number;
  /** Ordinal of this callType's call within its scope. */
  n: number;
  /** ctx.step of the call, when given. */
  step?: string;
  /** Name of the saved probe input. */
  label?: string;
  request: {
    messages: LlmMessage[];
    tools: RecordTool[];
    toolChoice?: "auto" | "required";
    avoidFamilies?: string[];
  };
  response: LlmResult;
  /** The call failed (LlmError): replay throws the same error, so the stage takes the same path as the recorded run. */
  error?: { code: string; message: string };
  usage: LlmUsage;
  costRub: number;
  latencyMs: number;
  recordedAt: string;
}

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

// ---------- prompt versions ----------

/** callType → repository paths (files or directories) holding its prompt; tools/fixtures/records/prompts.json. */
export type PromptManifest = Record<string, readonly string[]>;

export const PROMPT_MANIFEST_PATH = join("tools", "fixtures", "records", "prompts.json");

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((f) => filesUnder(join(path, f)));
}

// Data a stage puts into its schema per input (the candidates of an enum, texts) — not the shape of the tool.
const DATA_KEYS = new Set(["enum", "const", "description", "default", "examples", "title"]);

/** The shape of a JSON schema: its data keys dropped (an enum of this run's candidates is not a new tool). */
export function schemaShape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaShape);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => !DATA_KEYS.has(k))
      .map(([k, v]) => [
        k,
        k === "properties"
          ? Object.fromEntries(Object.entries(v as object).map(([p, x]) => [p, schemaShape(x)]))
          : schemaShape(v),
      ]),
  );
}

/** Hash of the tools offered: names and the shapes of their JSON schemas, order-free. */
export function toolsHash(tools: readonly Pick<LlmTool, "name" | "parameters">[] = []): string {
  return sha(
    tools
      .map((t) => `${t.name}:${schemaHash(schemaShape(t.parameters))}`)
      .sort()
      .join(","),
  ).slice(0, 8);
}

/**
 * The prompt version of a call: the hash of the source files of its prompt (the manifest), so any edit of a stage's prompt
 * invalidates its records; a callType outside the manifest (or without its sources, e.g. in a server image) — the hash
 * of its system messages. The tool schemas are part of the version.
 */
export class PromptVersions {
  private readonly root: string;
  private readonly manifest: PromptManifest;
  private readonly cache = new Map<string, string | null>();

  constructor(o: { root?: string; manifest?: PromptManifest } = {}) {
    this.root = o.root ?? findRepoRoot();
    const path = join(this.root, PROMPT_MANIFEST_PATH);
    this.manifest =
      o.manifest ?? (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PromptManifest) : {});
  }

  /** Source hash of a callType's prompt, or null when the manifest has no readable source for it. */
  sources(callType: string): string | null {
    if (!this.cache.has(callType)) {
      const paths = this.manifest[callType] ?? [];
      const files = paths.flatMap((p) => filesUnder(join(this.root, p)));
      this.cache.set(
        callType,
        files.length
          ? sha(files.map((f) => `${f.slice(this.root.length)}\n${sha(readFileSync(f))}`).join("\n")).slice(
              0,
              8,
            )
          : null,
      );
    }
    return this.cache.get(callType) ?? null;
  }

  of(input: Pick<RouteInput, "callType" | "messages" | "tools">): string {
    const src =
      this.sources(input.callType) ??
      sha(
        input.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n"),
      ).slice(0, 8);
    return `${src}.${toolsHash(input.tools)}`;
  }
}

export const recordKey = (callType: string, promptVersion: string, model: string): string =>
  `${callType}@${promptVersion}/${model}`;

// ---------- redaction ----------

// Secrets: provider keys, bearer tokens, JWTs, key=value pairs of credentials. `secret://name` references stay.
const SECRET_RES: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "<secret>"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <secret>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<secret>"],
  [
    /\b((?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|token)["']?\s*[:=]\s*["']?)(?!secret:\/\/)[^\s"',}]{6,}/gi,
    "$1<secret>",
  ],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Strong identifiers become format-keeping stand-ins: a replayed answer still passes the validators of its fields.
const STRONG_RES: [RegExp, (m: string) => string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => "user@example.com"],
  [/\b\d{4}(?:[ -]?\d{4}){3}\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "0000 0000 0000 0000" : m)],
  [/\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b/g, () => "000-000-000 00"],
  [/(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g, () => "+7 900 000-00-00"],
  [/(?<![\d-])\d{2}\s?\d{2}\s№?\s?\d{6}\b/g, () => "00 00 000000"],
];

/** Removes secrets and strong identifiers (e-mail, phone, card, SNILS, passport) from every string of a value. */
export function redact<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const [re, to] of SECRET_RES) out = out.replace(re, to);
      for (const [re, to] of STRONG_RES) out = out.replace(re, to);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

// ---------- the book of records ----------

export const RECORDS_DIR = join("tools", "fixtures", "records");

/** Records of one jsonl file (a probe file per callType, or one file per recorded e2e run). */
export class RecordBook {
  readonly path: string;
  private lines: RecordLine[] | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** A book under <repo>/tools/fixtures/records: `probe/<callType>`, `e2e-v3`… */
  static named(name: string, root = findRepoRoot()): RecordBook {
    return new RecordBook(join(root, RECORDS_DIR, `${name}.jsonl`));
  }

  all(): RecordLine[] {
    if (this.lines === null) {
      this.lines = existsSync(this.path)
        ? readFileSync(this.path, "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as RecordLine)
        : [];
    }
    return this.lines;
  }

  /** Adds a record; a newer record of the same key, scope, ordinal and label replaces the old one. */
  add(line: RecordLine): void {
    const same = (l: RecordLine) =>
      l.key === line.key && l.scope === line.scope && l.n === line.n && l.label === line.label;
    this.lines = [...this.all().filter((l) => !same(l)), line];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, this.lines.map((l) => `${stableStringify(l)}\n`).join(""));
  }

  /** Drops every record (a new recording of the whole run). */
  clear(): void {
    this.lines = [];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, "");
  }
}

/** Order of first appearance of each system: the scope of a call. One per recorded or replayed run (process). */
export class RecordScopes {
  private readonly ids = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  next(input: RouteInput): { scope: number; n: number } {
    const id = input.ctx.systemId ?? input.ctx.orgId;
    if (!this.ids.has(id)) this.ids.set(id, this.ids.size);
    const scope = this.ids.get(id) as number;
    const k = `${scope}\u0000${input.callType}`;
    const n = this.counts.get(k) ?? 0;
    this.counts.set(k, n + 1);
    return { scope, n };
  }
}

function recordTools(tools: readonly LlmTool[] = []): RecordTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schemaHash: schemaHash(t.parameters),
    parameters: t.parameters,
  }));
}

export interface RecordingOptions {
  book: RecordBook;
  source: RecordSource;
  versions?: PromptVersions;
  /** Name of the current probe input (read at each call). */
  label?: () => string | undefined;
  /** Every record written (the probe's report). */
  onRecord?: (line: RecordLine) => void;
  /** Refusals of the models are recorded too (default); a probe keeps answers only. */
  recordErrors?: boolean;
  /** Shared by the routers of one run (a platform makes a router per build): default — this router's own. */
  scopes?: RecordScopes;
  now?: () => number;
}

/** A router that writes every successful call of `inner` (live) as a record. */
export function recordingRouter(inner: Router, o: RecordingOptions): Router {
  const versions = o.versions ?? new PromptVersions();
  const scopes = o.scopes ?? new RecordScopes();
  const now = o.now ?? Date.now;
  return {
    mode: inner.mode,
    registry: inner.registry,
    ...(inner.inflightT1 ? { inflightT1: inner.inflightT1.bind(inner) } : {}),
    async route(input: RouteInput): Promise<RouteOutput> {
      const { scope, n } = scopes.next(input);
      const started = now();
      const promptVersion = versions.of(input);
      const label = o.label?.();
      const request = () =>
        redact({
          messages: withoutAttachmentBytes(input.messages),
          tools: recordTools(input.tools),
          ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
          ...(input.avoidFamilies?.length ? { avoidFamilies: [...input.avoidFamilies] } : {}),
        });
      let out: RouteOutput;
      try {
        out = await inner.route(input);
      } catch (e) {
        // A refusal of the models is part of the run: replay repeats it (ABORTED is the caller's own cancel).
        if (o.recordErrors !== false && e instanceof LlmError && e.code !== "ABORTED") {
          const line: RecordLine = {
            v: 2,
            key: recordKey(input.callType, promptVersion, "error"),
            callType: input.callType,
            promptVersion,
            model: "error",
            tier: "T0",
            source: o.source,
            scope,
            n,
            ...(input.ctx.step ? { step: input.ctx.step } : {}),
            ...(label ? { label } : {}),
            request: request(),
            response: { toolCalls: [], finishReason: "error" },
            error: { code: e.code, message: e.message },
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
            costRub: 0,
            latencyMs: now() - started,
            recordedAt: new Date(now()).toISOString(),
          };
          o.book.add(line);
          o.onRecord?.(line);
        }
        throw e;
      }
      const line: RecordLine = {
        v: 2,
        key: recordKey(input.callType, promptVersion, out.model),
        callType: input.callType,
        promptVersion,
        model: out.model,
        tier: out.tier,
        source: o.source,
        scope,
        n,
        ...(input.ctx.step ? { step: input.ctx.step } : {}),
        ...(label ? { label } : {}),
        request: request(),
        response: redact(out.result),
        usage: out.usage,
        costRub: Math.round(out.creditsCharged * inner.registry.rubPerCredit * 1e4) / 1e4,
        latencyMs: now() - started,
        recordedAt: new Date(now()).toISOString(),
      };
      o.book.add(line);
      o.onRecord?.(line);
      return out;
    },
  };
}

export interface ReplayOptions {
  registry: Registry;
  /** Books searched in order (e.g. the recorded e2e run, then the probes). */
  books: readonly RecordBook[];
  versions?: PromptVersions;
  /** Called on each miss before the error is thrown (the stand logs it and fails the run). */
  onMiss?: (miss: RecordMiss) => void;
  /** Called on each answered call (the stand counts what the run took from records). */
  onHit?: (line: RecordLine) => void;
  /** A call past the end of the recorded run (records of its version exist, not this many): it fails as unavailable. */
  onBeyond?: (miss: RecordMiss) => void;
  /** Shared by the routers of one run: default — this router's own. */
  scopes?: RecordScopes;
}

export interface RecordMiss {
  callType: string;
  promptVersion: string;
  scope: number;
  n: number;
  message: string;
}

export interface ReplayRouter extends Router {
  /** Calls that found no record of their prompt version (each also threw FIXTURE_MISS). */
  readonly misses: readonly RecordMiss[];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A run of digits with the hex, separators and time marks around it: ids, timestamps, their redacted remains. */
const DIGITS_RE = /\d[\da-f :.\-TZ]*/gi;

/** Fingerprint of recorded messages: the ids, timestamps and numbers of a run do not count. */
function requestPrint(messages: readonly LlmMessage[]): string {
  return sha(stableStringify(messages).replace(UUID_RE, "#").replace(DIGITS_RE, "#"));
}

/**
 * A router that answers from records only (CI). A record matches by callType and prompt version (sources + tool
 * schemas); among those, an unused record of the same scope with the same request first (parallel calls of one type —
 * three art directions, sections — reach the router in any order), then the same scope and ordinal, then the same
 * ordinal of any scope, then — for a probe record — its first one. No record → FIXTURE_MISS «нет записи для <callType>@<версия>» and the miss is kept: the caller fails
 * the run, the stage never takes its deterministic fallback silently.
 */
export function replayRouter(o: ReplayOptions): ReplayRouter {
  const versions = o.versions ?? new PromptVersions();
  const scopes = o.scopes ?? new RecordScopes();
  const misses: RecordMiss[] = [];
  const used = new Set<RecordLine>();
  const prints = new WeakMap<RecordLine, string>();
  const printOf = (l: RecordLine): string => {
    let p = prints.get(l);
    if (p === undefined) {
      p = requestPrint(l.request.messages);
      prints.set(l, p);
    }
    return p;
  };
  return {
    mode: "fixture",
    registry: o.registry,
    misses,
    async route(input: RouteInput): Promise<RouteOutput> {
      const { scope, n } = scopes.next(input);
      const promptVersion = versions.of(input);
      const all = o.books
        .flatMap((b) => b.all())
        .filter((l) => l.callType === input.callType && l.promptVersion === promptVersion);
      const offered = new Set((input.tools ?? []).map((t) => t.name));
      const usable = all.filter((l) => l.response.toolCalls.every((c) => offered.has(c.name)));
      const print = requestPrint(redact(withoutAttachmentBytes(input.messages)));
      const line =
        usable.find((l) => l.scope === scope && !used.has(l) && printOf(l) === print) ??
        usable.find((l) => l.scope === scope && l.n === n) ??
        usable.find((l) => l.n === n) ??
        usable.find((l) => l.source === "probe");
      if (!line && usable.length) {
        // The recorded run made fewer calls (a live stage stopped on its time budget, which replay does not spend):
        // the call fails as the models being unavailable — the stage stops here as well.
        const message = `запись прогона закончилась: ${input.callType}@${promptVersion} — вызов ${n + 1}`;
        o.onBeyond?.({ callType: input.callType, promptVersion, scope, n, message });
        throw new LlmError("LLM_UNAVAILABLE", "Модели сейчас недоступны. Попробуйте позже.", {
          callType: input.callType,
          replay: message,
        });
      }
      if (!line) {
        const message = `нет записи для ${input.callType}@${promptVersion}`;
        const miss = { callType: input.callType, promptVersion, scope, n, message };
        misses.push(miss);
        o.onMiss?.(miss);
        throw new LlmError("FIXTURE_MISS", message, {
          callType: input.callType,
          promptVersion,
          hint: "Перезапишите записи: воркфлоу stage-probe (docs: tools/fixtures/records/README.md).",
        });
      }
      used.add(line);
      o.onHit?.(line);
      if (line.error)
        throw new LlmError(line.error.code as LlmErrorCode, line.error.message, { callType: input.callType });
      const model = o.registry.models.find((m) => m.id === line.model);
      const credits = model ? line.costRub / o.registry.rubPerCredit : 0;
      return {
        tier: line.tier,
        model: line.model,
        result: line.response,
        usage: line.usage,
        creditsCharged: Math.ceil(credits * 1000) / 1000,
        creditsMilli: Math.ceil(credits * 1000),
        routeReason: line.tier === "T1" ? "default_T1" : "default_T0",
        scrubbed: line.tier === "T1",
        ruFallback: false,
      };
    },
  };
}
