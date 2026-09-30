// Which recorded transcript a brief replays offline (eval.yaml#fixtures): its own suite=eval fixture
// (tools/fixtures/eval/<briefId>.jsonl, written by --llm-mode=record), else a demo stand-in (tools/fixtures/demo).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseYamlFiles } from "../../specs/validate.mjs";

export const REPO = join(import.meta.dirname, "..", "..", "..");
export const FIXTURES_DIR = join(REPO, "tools", "fixtures");

/** Briefs whose scenario the golden demo transcripts cover (tools/fixtures/golden/<name>.yaml). */
export const DEMO_STANDINS: Readonly<Record<string, string>> = {
  "ev-01-forum-registration": "forum",
  "gd-01-cake-preorder": "bakery",
};
/** --dry-run: every other brief replays a demo transcript of its segment (mechanics and pii_leaks, not quality). */
export const DRY_RUN_STANDIN: Readonly<Record<string, string>> = {
  events: "forum",
  made_to_order: "bakery",
  horizontal: "forum",
};

export interface FixtureChoice {
  suite: "demo" | "eval";
  name: string;
  /** Replays a demo transcript instead of the brief's own recording. */
  standIn: boolean;
}

export function resolveFixture(
  brief: { id: string; segment: string },
  o: { dryRun: boolean; dir?: string },
): FixtureChoice | null {
  const dir = o.dir ?? FIXTURES_DIR;
  if (existsSync(join(dir, "eval", `${brief.id}.jsonl`)))
    return { suite: "eval", name: brief.id, standIn: false };
  const demo = DEMO_STANDINS[brief.id] ?? (o.dryRun ? DRY_RUN_STANDIN[brief.segment] : undefined);
  return demo ? { suite: "demo", name: demo, standIn: true } : null;
}

type GoldenAnswer = { forkId: string; optionId: string; byRecommendation: boolean };
type GoldenDoc = { brief?: string; answers?: GoldenAnswer[] };

/**
 * A demo transcript is replayed with its own brief and answers: fork selection depends on the brief text
 * (orchestrator taxonomy), so another brief would not match the recorded questions. Sentences of the eval brief
 * that carry canaries are appended, so pii_leaks still sees them in the outbound payloads.
 */
export function standInScenario(
  name: string,
  brief: { text: string; canaries?: string[] },
): { text: string; answers: Record<string, string> } {
  const path = join(FIXTURES_DIR, "golden", `${name}.yaml`);
  const r = (parseYamlFiles([path]) as Record<string, { ok?: GoldenDoc; error?: string }>)[path];
  if (!r || r.error !== undefined || typeof r.ok?.brief !== "string")
    throw new Error(`golden ${name}: ${r?.error}`);
  const canaries = brief.canaries ?? [];
  const extra = brief.text.split(/(?<=[.!?])\s+/).filter((s) => canaries.some((c) => s.includes(c)));
  return {
    text: [r.ok.brief.trim(), ...extra].join(" "),
    answers: Object.fromEntries(
      (r.ok.answers ?? []).filter((a) => !a.byRecommendation).map((a) => [a.forkId, a.optionId]),
    ),
  };
}
