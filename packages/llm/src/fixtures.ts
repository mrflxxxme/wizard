// Fixture provider storage and keys: specs/quality/eval.yaml#fixtures.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LlmError } from "./errors.js";
import type { CallType, LlmMessage, LlmResult, LlmTool } from "./types.js";

export type FixtureSuite = "demo" | "eval" | "unit";

export interface FixtureRequest {
  messages: LlmMessage[];
  tools: { name: string; schemaHash: string }[];
  params: { temperature: number; max_tokens: number };
}

export interface FixtureLine {
  v: 1;
  key: string;
  callType: CallType;
  modelId: string;
  request: FixtureRequest;
  response: LlmResult;
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number };
  latencyMs: number;
  recordedAt: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function schemaHash(parameters: unknown): string {
  return sha256(stableStringify(parameters)).slice(0, 16);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

export interface CanonicalInput {
  callType: CallType;
  modelId: string;
  messages: readonly LlmMessage[];
  tools?: readonly LlmTool[];
  temperature: number;
  maxTokens: number;
  runId?: string;
  systemId?: string;
}

/** eval.yaml#fixtures.canonical_request */
export function canonicalRequest(input: CanonicalInput): string {
  const uuids = new Map<string, number>();
  const norm = (s: string): string => {
    let out = s;
    if (input.runId) out = out.split(input.runId).join("<runId>");
    if (input.systemId) out = out.split(input.systemId).join("<systemId>");
    out = out.replace(UUID_RE, (u) => {
      const k = u.toLowerCase();
      if (!uuids.has(k)) uuids.set(k, uuids.size + 1);
      return `<uuid:${uuids.get(k)}>`;
    });
    return out.replace(ISO_DATE_RE, "<date>").replace(/[ \t]+$/gm, "");
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return norm(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return stableStringify({
    callType: input.callType,
    modelId: input.modelId,
    messages: walk(input.messages),
    tools: (input.tools ?? []).map((t) => ({ name: t.name, schemaHash: schemaHash(t.parameters) })),
    temperature: input.temperature,
    max_tokens: input.maxTokens,
  });
}

export function requestKey(input: CanonicalInput): string {
  return sha256(canonicalRequest(input));
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export interface FixtureStoreOptions {
  /** Default: <repo>/tools/fixtures */
  dir?: string;
  suite: FixtureSuite;
  name: string;
  /** WIZARD_FIXTURE_LENIENT=1 (local only): eval|unit miss → next unused line of the same callType. */
  lenient?: boolean;
}

export interface LookupInput {
  callType: CallType;
  key: string;
  toolNames: string[];
  /** Scrubbed last message, used only for the FIXTURE_MISS hint. */
  lastMessage: string;
}

export class FixtureStore {
  readonly path: string;
  readonly suite: FixtureSuite;
  private readonly lenient: boolean;
  private lines: FixtureLine[] | null = null;
  private readonly used = new Set<number>();
  private readonly ordinals = new Map<string, number>();

  constructor(opts: FixtureStoreOptions) {
    const dir = opts.dir ?? join(findRepoRoot(), "tools", "fixtures");
    this.path = join(dir, opts.suite, `${opts.name}.jsonl`);
    this.suite = opts.suite;
    this.lenient = opts.lenient ?? false;
  }

  private load(): FixtureLine[] {
    if (this.lines === null) {
      this.lines = existsSync(this.path)
        ? readFileSync(this.path, "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as FixtureLine)
        : [];
    }
    return this.lines;
  }

  lookup(q: LookupInput): FixtureLine {
    const lines = this.load();
    if (this.suite === "demo") {
      const n = this.ordinals.get(q.callType) ?? 0;
      this.ordinals.set(q.callType, n + 1);
      const line = lines.filter((l) => l.callType === q.callType)[n];
      const names = (xs: string[]) => [...xs].sort().join(",");
      if (line && names(line.request.tools.map((t) => t.name)) === names(q.toolNames)) return line;
      throw this.miss(q);
    }
    const matches = lines.map((l, i) => [l, i] as const).filter(([l]) => l.key === q.key);
    const fresh = matches.find(([, i]) => !this.used.has(i));
    const hit = fresh ?? matches[matches.length - 1];
    if (hit) {
      this.used.add(hit[1]);
      return hit[0];
    }
    if (this.lenient) {
      const i = lines.findIndex((l, j) => l.callType === q.callType && !this.used.has(j));
      const line = lines[i];
      if (line) {
        this.used.add(i);
        return line;
      }
    }
    throw this.miss(q);
  }

  append(line: FixtureLine): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.load().push(line);
    this.used.add(this.load().length - 1);
  }

  private miss(q: LookupInput): LlmError {
    return new LlmError("FIXTURE_MISS", `Нет записанного ответа модели для шага «${q.callType}».`, {
      callType: q.callType,
      lastMessage: q.lastMessage.slice(0, 200),
      fixture: this.path,
    });
  }
}

export function briefHash(brief: string): string {
  return sha256(brief.normalize("NFC").trim());
}

/**
 * Briefs allowed for record mode (eval.yaml#fixtures.rules): `text` of tools/eval/briefs/*.json and
 * demo briefs tools/fixtures/demo/briefs/*.txt.
 */
export function loadAllowedBriefHashes(root = findRepoRoot()): Set<string> {
  const out = new Set<string>();
  const evalDir = join(root, "tools", "eval", "briefs");
  if (existsSync(evalDir)) {
    for (const f of readdirSync(evalDir).filter((x) => x.endsWith(".json"))) {
      const brief = JSON.parse(readFileSync(join(evalDir, f), "utf8")) as { text?: unknown };
      if (typeof brief.text === "string") out.add(briefHash(brief.text));
    }
  }
  const demoDir = join(root, "tools", "fixtures", "demo", "briefs");
  if (existsSync(demoDir)) {
    for (const f of readdirSync(demoDir).filter((x) => x.endsWith(".txt"))) {
      out.add(briefHash(readFileSync(join(demoDir, f), "utf8")));
    }
  }
  return out;
}
