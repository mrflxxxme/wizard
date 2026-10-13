// Models of the v3 stand (stand/v3.ts, D78; V4-03): the build's calls — the texts of the three directions and the art
// director (art_direction), the pages (page_compose, signature_section), the visual critic (critic_visual), the
// techreview — answer from the records of a real recorded run (tools/fixtures/records/e2e-v3.jsonl): no network and no
// money in CI. A call without a record fails loudly: the miss goes to V3_RECORDS_LOG and the spec fails the run — no
// stage takes its deterministic fallback silently. WIZARD_V3_RECORDS=record (the stage-probe workflow, e2e=v3) runs
// the same calls on live models and writes the records anew.
// The grill interview stays the dental dialog of V3-03 (packages/agents/test/interview-v3/helpers.ts DENTAL_SCRIPT
// without its search turn — the stand has no web tools): the spec walks its questions in the UI; then a wish after the
// build edits the brief and finishes again.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createRegistry,
  createRouter,
  LlmError,
  RecordBook,
  RecordScopes,
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

/** The wish of the owner after the build, as the spec types it in the chat. */
export const V3_WISH = "Добавьте, что к нам приходят и родители с детьми";
/** The audience of the brief after the wish (the model's edit). */
export const V3_WISH_AUDIENCE = "Пациенты клиники в Казани и родители с детьми";
/** The records of the stand's run (tools/fixtures/records/e2e-v3.jsonl). */
export const V3_RECORDS = "e2e-v3";

/** One line of V3_RECORDS_LOG: what each call of the run took. */
export interface V3RecordUse {
  callType: string;
  outcome: "hit" | "miss" | "beyond" | "recorded";
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
const scopes = new RecordScopes();
let book: RecordBook | null = null;

/** WIZARD_V3_RECORDS=record: live models, the run's records written anew; otherwise replay. */
const recording = () => process.env.WIZARD_V3_RECORDS === "record";
/** A recording run stops calling models at this spend (WIZARD_V3_RECORDS_CAP_RUB, default 60 ₽). */
const capRub = () => Number(process.env.WIZARD_V3_RECORDS_CAP_RUB) || 60;
let spentRub = 0;

/** The platform router of the v3 stand: the scripted interview, every other call from the records. */
export function v3Router(opts: RouterOptions): Router {
  const registry = opts.registry ?? createRegistry({ buildDefaultTier: "T1" });
  if (!book) {
    book = RecordBook.named(V3_RECORDS);
    if (recording()) book.clear();
  }
  const records: Router = recording()
    ? recordingRouter(
        createRouter({ ...opts, registry, mode: "live", sink: { write: () => {} }, t1Reserve: true }),
        {
          book,
          source: "e2e",
          scopes,
          onRecord: (l) => {
            spentRub += l.costRub;
            use({ callType: l.callType, outcome: "recorded", model: l.model });
          },
        },
      )
    : replayRouter({
        registry,
        books: [book],
        scopes,
        onHit: (l) => use({ callType: l.callType, outcome: "hit", model: l.model }),
        onBeyond: (m) => use({ callType: m.callType, outcome: "beyond", message: m.message }),
        onMiss: (m) => {
          use({ callType: m.callType, outcome: "miss", message: m.message });
          console.error(`::error::[v3-stand] ${m.message} — перезапишите записи e2e: stage-probe с e2e=v3`);
        },
      });
  return {
    mode: records.mode,
    registry,
    async route(input: RouteInput): Promise<RouteOutput> {
      if (input.callType === "interview_v3") return interview(input);
      if (recording() && spentRub >= capRub()) {
        use({
          callType: input.callType,
          outcome: "miss",
          message: `запись остановлена на потолке ${capRub()} ₽`,
        });
        throw new LlmError("BUDGET_EXCEEDED", `Запись остановлена на потолке ${capRub()} ₽.`);
      }
      return records.route(input);
    },
  };
}
