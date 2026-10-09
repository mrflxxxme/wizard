// V3-15 techreview of the harness v3: the deterministic part, the reviewer of another model family, ≤ 2 fix rounds.
export {
  CHAINS,
  type ChainDef,
  type ChainLink,
  chainChecks,
  coveringAcceptance,
  findLink,
  referenceSpec,
} from "./chains.js";
export {
  accessibilityChecks,
  blockerLine,
  blockingChecks,
  contractTests,
  deterministicChecks,
  fromGate,
  G0_LOCAL_CHECKS,
  G2_STATIC_CHECKS,
  integrationChecks,
  localGates,
  migrationDryRun,
  OWNER_INPUT_SUFFIX_RU,
  performanceChecks,
  rlsCoverage,
} from "./checks.js";
export { DIGEST_SOURCE_MAX, extensionsOf, signatureOf, type TechDigest, techDigest } from "./digest.js";
export { applyFix, type FixResult, newBlockers, patchRefusal } from "./fixes.js";
export {
  defaultBuilderFamilies,
  evidenceFound,
  familyOf,
  MAX_FINDINGS,
  ownerInputFinding,
  resolves,
  reviewRound,
  submitTechreview,
  TECHREVIEW_CALL_TYPE,
  type TechreviewInput,
  techreviewInputSchema,
  techreviewMessages,
} from "./reviewer.js";
export {
  createTechreview,
  runTechreview,
  TECHREVIEW_MAX_ROUNDS,
  type TechreviewHookResult,
  techBlockers,
} from "./run.js";
export * from "./types.js";
