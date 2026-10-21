// Artifacts of the role pipeline (V5-03, D80 (6), grill-10 Р7): every role hands the next one a JSON record.
import type { DirectionId } from "@wizard/ui-kit";
import { z } from "zod";

const t = (max: number, min = 1) => z.string().trim().min(min).max(max);

/** Roles in chain order; the name is also the artifact record (`ui/v5/<name>.json`, checkpoint `roles:<name>`). */
export const ROLE_ARTIFACTS = ["positioning", "copy", "copy-edited", "blocks", "signature"] as const;
export type RoleArtifact = (typeof ROLE_ARTIFACTS)[number];

export const DIRECTION_IDS = ["masterskaya", "nochnoy-produkt"] as const satisfies readonly DirectionId[];

/** Strategist: positioning.json. */
export const positioningSchema = z.strictObject({
  name: t(60),
  /** What the business is and for whom, one sentence with a concrete fact. */
  essence: t(240),
  audience: t(240),
  /** The unique selling points; each one carries a figure or a checkable fact. */
  usp: z.array(t(160)).min(2).max(4),
  /** Proof the page shows: numbers, years, ratings, guarantees, with their source in the brief. */
  proof: z.array(t(160)).min(1).max(5),
  /** Tone of voice in two or three working words plus what the text never does. */
  tone: t(200),
  direction: z.enum(DIRECTION_IDS),
  /** Why this direction suits the business, one sentence. */
  directionWhy: t(240),
  sitemap: z
    .array(z.strictObject({ id: t(24).regex(/^[a-z][a-z0-9-]*$/), purpose: t(160) }))
    .min(5)
    .max(9),
});
export type Positioning = z.output<typeof positioningSchema>;

/** One section's texts: free-form by section, mapped to block slots by the director. */
export const copySectionSchema = z.strictObject({
  id: t(24),
  headline: t(120),
  body: t(400).optional(),
  items: z
    .array(z.strictObject({ title: t(80), text: t(240).optional(), value: t(40).optional() }))
    .max(8)
    .default(() => []),
  cta: t(40).optional(),
});
/** Copywriter: copy.json — all texts, by the strategist's sitemap, before any layout. */
export const copySchema = z.strictObject({
  sections: z.array(copySectionSchema).min(5).max(9),
  /** Facts the copy uses that the brief does not give (the editor and the owner check them). */
  assumptions: z
    .array(t(160))
    .max(6)
    .default(() => []),
});
export type Copy = z.output<typeof copySchema>;

/** Editor: the copy rewritten where the bans caught it, plus what it changed. */
export const editedSchema = z.strictObject({
  copy: copySchema,
  changes: z
    .array(t(200))
    .max(20)
    .default(() => []),
});

/** One block of the page: catalog id, variant and the content of its slots. */
export const pageBlockSchema = z.strictObject({
  id: t(60),
  variant: t(40).optional(),
  content: z.record(z.string(), z.unknown()),
});
export type PageBlock = z.output<typeof pageBlockSchema>;

/** Director: blocks.json — the page as catalog blocks. */
export const blocksSchema = z.strictObject({
  direction: z.enum(DIRECTION_IDS),
  blocks: z.array(pageBlockSchema).min(6).max(9),
});
export type BlocksPage = z.output<typeof blocksSchema>;

/** Signature section candidate: free TSX. */
export const signatureCandidateSchema = z.strictObject({
  title: t(80),
  /** What the section shows, in Russian, for the owner. */
  idea: t(240),
  /** Where it goes: after this block id. */
  after: t(60),
  source: z.string().min(200).max(14000),
});
export type SignatureCandidate = z.output<typeof signatureCandidateSchema>;

/** The signature record: the winning candidate and how it won. */
export const signatureRecordSchema = signatureCandidateSchema.extend({ winner: z.enum(["A", "B", "only"]) });

export const judgeSchema = z.strictObject({
  pick: z.enum(["A", "B"]),
  why: t(400, 10),
});

/** What a pipeline run reports (outcome.roles): spend, rounds, models, notes. */
export interface RolesReport {
  costRub: number;
  /** Critic rounds that changed slots (0–2). */
  criticRounds: number;
  /** Models by role (the last answering model of each). */
  models: Record<string, string>;
  /** Artifacts saved as records. */
  artifacts: string[];
  notes: string[];
}
