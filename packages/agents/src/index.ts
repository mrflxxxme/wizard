// @wizard/agents public API: shared text rules and the development-request contract; agents live in subpaths
// (./orchestrator, ./builder, ./qa, ./host, ./core).
export const PACKAGE = "@wizard/agents";

/** Honest capability gaps: categories, host contract, report_capability_gap tool and the owner-facing answer. */
export {
  type CapabilityGap,
  capabilityGapSchema,
  DEVELOPMENT_REQUEST_CATEGORIES,
  type DevelopmentRequestCategory,
  type DevelopmentRequestInput,
  type GapToolOptions,
  gapMessage,
  gapOutOfScope,
  gapsPromptSection,
  PLATFORM_CAN,
  PLATFORM_LIMITS,
  type RecordDevelopmentRequest,
  reportCapabilityGapTool,
  SUPPORT_BUTTON,
} from "./gaps.js";
/** Shared rules for text written for people (D48, D49): chat — to the owner, system — inside client systems. */
export { type TextRulesKind, textRules, textRulesSection } from "./text-rules.js";
