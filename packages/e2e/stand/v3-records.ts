// V4-19: the records of the v3 stand's run by stage — tools/fixtures/records/e2e-v3/<callType>.jsonl — so two PRs that
// edit different stages do not conflict in one file, and a partial re-recording (WIZARD_V3_RECORDS=record-stale) calls
// live models only for the stale stages and everything after them in the build's pipeline: replay does not compare the
// input, so a stage re-recorded upstream would leave the later stages answering about another site.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type CallType,
  PromptVersions,
  RECORDS_DIR,
  RecordBook,
  type RecordLine,
  type Registry,
} from "@wizard/llm";

/** The repository root (the stand runs from packages/e2e). */
export const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** The folder of the stand's records under tools/fixtures/records. */
export const V3_RECORDS_DIR = "e2e-v3";

/**
 * The order of the build's model calls (levels: a stage reads what the lower levels made). interview_v3 is scripted
 * by the stand, never recorded.
 */
export const V3_PIPELINE: Readonly<Record<string, number>> = {
  brief_extract: 0,
  direction_texts: 1,
  art_direction: 1,
  photo_pick: 2,
  page_compose: 3,
  signature_section: 3,
  critic_visual: 4,
  techreview: 5,
};

/** Level of a call type; one outside the pipeline is the last (re-recording it touches nothing else). */
export const levelOf = (callType: string): number => V3_PIPELINE[callType] ?? Number.MAX_SAFE_INTEGER;

/** The book of one stage. */
export const stageBook = (callType: string, root = REPO_ROOT): RecordBook =>
  RecordBook.named(`${V3_RECORDS_DIR}/${callType}`, root);

/** Every stage book in the folder. */
export function stageBooks(root = REPO_ROOT): Map<string, RecordBook> {
  const dir = join(root, RECORDS_DIR, V3_RECORDS_DIR);
  const out = new Map<string, RecordBook>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort())
    if (f.endsWith(".jsonl"))
      out.set(f.slice(0, -".jsonl".length), stageBook(f.slice(0, -".jsonl".length), root));
  return out;
}

/** Why the records of a stage are stale: a line of an older prompt, or a model that is not on the route any more. */
export function staleReason(
  callType: string,
  lines: readonly RecordLine[],
  o: { versions: PromptVersions; registry: Registry },
): string | null {
  const src = o.versions.sources(callType);
  const old = lines.find((l) => src !== null && l.promptVersion.split(".")[0] !== src);
  if (old) return `промпт изменился (${old.promptVersion.split(".")[0]} → ${src})`;
  const route = o.registry.routes[callType as CallType];
  const chain = new Set(route ? Object.values(route.chain).flat() : []);
  const foreign = lines.find((l) => l.model !== "error" && route && !chain.has(l.model));
  if (foreign) return `модели ${foreign.model} нет в маршруте`;
  return null;
}

/** The stale stages of the books with their reasons (the freshness test and record-stale read it). */
export function staleStages(
  books: ReadonlyMap<string, RecordBook>,
  o: { versions?: PromptVersions; registry: Registry },
): Map<string, string> {
  const versions = o.versions ?? new PromptVersions();
  const out = new Map<string, string>();
  for (const [ct, book] of books) {
    const why = staleReason(ct, book.all(), { versions, registry: o.registry });
    if (why) out.set(ct, why);
  }
  return out;
}

/** The lowest pipeline level a partial re-recording starts from (every stage at or above it is called live). */
export function liveFromLevel(stale: Iterable<string>): number {
  let from = Number.POSITIVE_INFINITY;
  for (const ct of stale) from = Math.min(from, levelOf(ct));
  return from;
}
