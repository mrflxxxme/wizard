// specs/platform/workflows.yaml#system_stage
export const STAGES = ["interview", "card", "building", "ready", "failed"] as const;
export type Stage = (typeof STAGES)[number];

const ALLOWED: ReadonlyArray<readonly [Stage, Stage]> = [
  ["interview", "card"],
  ["card", "card"],
  ["card", "interview"],
  ["card", "building"],
  ["ready", "card"],
  ["card", "ready"],
  ["ready", "building"],
  ["building", "ready"],
  ["building", "failed"],
  ["failed", "interview"],
  // POST /systems/:id/fix after a build that never produced a preview (impl-notes M0-15).
  ["failed", "building"],
];

export class IllegalTransition extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal system stage transition ${from} → ${to}`);
    this.name = "IllegalTransition";
  }
}

export function canTransition(from: string, to: string): boolean {
  return ALLOWED.some(([f, t]) => f === from && t === to);
}

export function assertTransition(from: string, to: string): Stage {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  return to as Stage;
}

/** Stage after a build ends (building → ready | failed). */
export function stageAfterBuild(succeeded: boolean, previewRevision: number | null): Stage {
  return succeeded || previewRevision !== null ? "ready" : "failed";
}
