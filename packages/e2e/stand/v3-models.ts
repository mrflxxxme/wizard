// Models of the v3 stand (stand/v3.ts, D78; V4-03): the build's calls — the texts of the three directions and the art
// director (art_direction), the pages (page_compose, signature_section), the visual critic (critic_visual), the
// techreview — answer from the records of a real recorded run (tools/fixtures/records/e2e-v3/<callType>.jsonl, V4-19):
// no network and no money in CI. A call without a record fails loudly: the miss goes to V3_RECORDS_LOG and the spec
// fails the run — no stage takes its deterministic fallback silently. WIZARD_V3_RECORDS=record runs every call on live
// models and writes the records anew; record-stale (the stage-probe workflow's default) only the stale stages and the
// stages after them (stand/v3-records.ts).
// The grill interview stays the dental dialog of V3-03 (packages/agents/test/interview-v3/helpers.ts DENTAL_SCRIPT
// without its search turn — the stand has no web tools): the spec walks its questions in the UI; then a wish after the
// build edits the brief and finishes again.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createRegistry,
  createRouter,
  LlmError,
  PromptVersions,
  type RecordBook,
  RecordScopes,
  type Registry,
  type RouteInput,
  type RouteOutput,
  type Router,
  type RouterOptions,
  recordingRouter,
  replayRouter,
} from "@wizard/llm";
import {
  DENTAL_SCRIPT,
  finish,
  type ScriptedAnswer,
  update,
} from "../../agents/test/interview-v3/helpers.js";
import { V3_RECORDS_LOG } from "./ports.js";
import { levelOf, liveFromLevel, stageBook, stageBooks, staleStages } from "./v3-records.js";

/** The wish of the owner after the build, as the spec types it in the chat. */
export const V3_WISH = "Добавьте, что к нам приходят и родители с детьми";
/** The audience of the brief after the wish (the model's edit). */
export const V3_WISH_AUDIENCE = "Пациенты клиники в Казани и родители с детьми";

/** One line of V3_RECORDS_LOG: what each call of the run took. */
export interface V3RecordUse {
  callType: string;
  outcome: "hit" | "miss" | "beyond" | "recorded" | "stale";
  model?: string;
  message?: string;
}

/** Interview answers in order: the dental dialog, then every later call (a wish) edits the audience and finishes. */
const INTERVIEW: readonly ScriptedAnswer[] = [
  ...(DENTAL_SCRIPT.slice(1) as ScriptedAnswer[]),
  [update({ audience: V3_WISH_AUDIENCE }), finish],
];

/** Calls of interview_v3 seen per system (each system of the specs walks its own dialog). */
const turns = new Map<string, number>();

function interview(input: RouteInput): RouteOutput {
  const key = input.ctx.systemId ?? input.ctx.orgId;
  const n = turns.get(key) ?? 0;
  turns.set(key, n + 1);
  const a = INTERVIEW[Math.min(n, INTERVIEW.length - 1)] as ScriptedAnswer;
  if (a instanceof Error) throw a;
  return {
    tier: "T1",
    model: "fixture",
    result: Array.isArray(a)
      ? {
          toolCalls: a.map((c, i) => ({
            id: `call_${input.callType}_${i + 1}`,
            name: c.name,
            args: c.args as Record<string, unknown>,
          })),
          finishReason: "tool-calls",
        }
      : { toolCalls: [], text: a, finishReason: "stop" },
    usage: { inputTokens: 2000, cachedTokens: 0, outputTokens: 300 },
    creditsCharged: 0.05,
    creditsMilli: 50,
    routeReason: "default_T1",
    scrubbed: true,
    ruFallback: false,
  };
}

function use(u: V3RecordUse): void {
  mkdirSync(dirname(V3_RECORDS_LOG), { recursive: true });
  appendFileSync(V3_RECORDS_LOG, `${JSON.stringify(u)}\n`);
}

/** One order of systems for every router of the stand's process (the platform makes a router per build). */
let scopes = new RecordScopes();
const versions = new PromptVersions();

/**
 * WIZARD_V3_RECORDS: unset — replay; `record` — every stage live, the records written anew; `record-stale` (V4-19) — the
 * stale stages (an older prompt, a model off the route, no record) and everything after them in the pipeline live, the
 * rest replayed.
 */
type RecordMode = "replay" | "record" | "record-stale";
const mode = (): RecordMode => {
  const v = process.env.WIZARD_V3_RECORDS;
  return v === "record" || v === "record-stale" ? v : "replay";
};
const recording = () => mode() !== "replay";
/** A recording run stops calling models at this spend (WIZARD_V3_RECORDS_CAP_RUB, default 60 ₽). */
const capRub = () => Number(process.env.WIZARD_V3_RECORDS_CAP_RUB) || 60;
let spentRub = 0;

/** The stage books of the run, and the pipeline level from which this run calls live models. */
let books: Map<string, RecordBook> | null = null;
let liveFrom = Number.POSITIVE_INFINITY;
/** Stages re-recorded by this run: their book was emptied on the first live call. */
const rewritten = new Set<string>();

/** Tests: the state of a run (the books, the live level, the spend, the scopes) starts anew. */
export function resetV3Records(): void {
  books = null;
  liveFrom = Number.POSITIVE_INFINITY;
  rewritten.clear();
  spentRub = 0;
  scopes = new RecordScopes();
}

function setup(registry: Registry, root?: string): Map<string, RecordBook> {
  if (books) return books;
  books = stageBooks(root);
  if (mode() === "record") {
    for (const b of books.values()) b.clear();
    liveFrom = 0;
  } else if (mode() === "record-stale") {
    const stale = staleStages(books, { versions, registry });
    for (const [ct, why] of stale) use({ callType: ct, outcome: "stale", message: why });
    liveFrom = liveFromLevel(stale.keys());
  }
  return books;
}

/** A record of the call's prompt version exists (the replay would answer or say the run ended there). */
const recorded = (all: ReadonlyMap<string, RecordBook>, input: RouteInput): boolean => {
  const version = versions.of(input);
  return (all.get(input.callType)?.all() ?? []).some((l) => l.promptVersion === version);
};

/** The platform router of the v3 stand: the scripted interview, every other call from the records (or live). */
export function v3Router(opts: RouterOptions, t: { root?: string; live?: Router } = {}): Router {
  const registry = opts.registry ?? createRegistry({ buildDefaultTier: "T1" });
  const all = setup(registry, t.root);
  let inner: Router | null = null;
  const writers = new Map<string, Router>();
  const writer = (callType: string): Router => {
    let w = writers.get(callType);
    if (!w) {
      inner ??=
        t.live ??
        createRouter({ ...opts, registry, mode: "live", sink: { write: () => {} }, t1Reserve: true });
      let book = all.get(callType);
      if (!book) {
        book = stageBook(callType, t.root);
        all.set(callType, book);
      }
      if (!rewritten.has(callType)) {
        book.clear();
        rewritten.add(callType);
      }
      w = recordingRouter(inner, {
        book,
        source: "e2e",
        scopes,
        versions,
        onRecord: (l) => {
          spentRub += l.costRub;
          use({ callType: l.callType, outcome: "recorded", model: l.model });
        },
      });
      writers.set(callType, w);
    }
    return w;
  };
  const replay = replayRouter({
    registry,
    books: [...all.values()],
    scopes,
    versions,
    onHit: (l) => use({ callType: l.callType, outcome: "hit", model: l.model }),
    onBeyond: (m) => use({ callType: m.callType, outcome: "beyond", message: m.message }),
    onMiss: (m) => {
      use({ callType: m.callType, outcome: "miss", message: m.message });
      console.error(
        `::error::[v3-stand] ${m.message} — перезапишите записи e2e: stage-probe с e2e_v3 (устаревшие этапы — сами)`,
      );
    },
  });
  return {
    mode: recording() ? "live" : replay.mode,
    registry,
    async route(input: RouteInput): Promise<RouteOutput> {
      if (input.callType === "interview_v3") return interview(input);
      if (recording()) {
        // record-stale: a stage without a record of its prompt is stale too — it and the later stages go live.
        if (mode() === "record-stale" && !rewritten.has(input.callType) && !recorded(all, input))
          liveFrom = Math.min(liveFrom, levelOf(input.callType));
        if (levelOf(input.callType) >= liveFrom) {
          if (spentRub >= capRub()) {
            use({
              callType: input.callType,
              outcome: "miss",
              message: `запись остановлена на потолке ${capRub()} ₽`,
            });
            throw new LlmError("BUDGET_EXCEEDED", `Запись остановлена на потолке ${capRub()} ₽.`);
          }
          return writer(input.callType).route(input);
        }
      }
      return replay.route(input);
    },
  };
}
