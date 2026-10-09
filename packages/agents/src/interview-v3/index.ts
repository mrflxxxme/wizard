// @wizard/agents/interview-v3 (V3-03; D77_v3 (8), (9), (12); grill-8 № 8, 9, 12): the grill interview of v3 — one
// question per turn along the tree, the system brief (C1) filled as it goes, the stop rule and the capability map by code.
/** «Карта возможностей»: level of a requirement by code, the brief's map, counts, the monthly «не умею» share. */
export {
  briefRequirements,
  CAPABILITY_LABELS,
  type CapabilityLevel,
  type CapabilityMap,
  type CapabilityMonth,
  type CapabilityVerdict,
  capabilityCounts,
  capabilityMap,
  dataModules,
  notYetShareByMonth,
  type Requirement,
  requirementLevel,
  scenarioLine,
} from "./capability.js";
/** Deterministic questions of the blocking topics (each option with its brief patch) and the recommended defaults. */
export { defaultPatch, type FallbackContext, type FallbackQuestion, fallbackQuestion } from "./fallback.js";
/** Stop rule by code: blocking gaps of a brief, the tree order of a question, why the interview stops. */
export { type BlockingGap, blockingGaps, questionOrderIssues, stopReason } from "./gaps.js";
/** The interview: start / answer / say a turn at a time; session, outputs, the short brief for the chat. */
export {
  adoptStoredBrief,
  briefSummaryText,
  createInterviewV3,
  InterviewV3,
  type InterviewV3Deps,
  type InterviewV3Failure,
  type InterviewV3Output,
  type InterviewV3Result,
  isInterviewV3Session,
  MAX_DEFERRED,
  newInterviewV3Session,
  publicQuestion,
  type V3Answer,
  type V3PublicQuestion,
} from "./interview.js";
/** Brief patches merged by code (ids, references, ПДн fields), the journal, assumptions, the capability refresh. */
export { addAssumption, addQa, applyBriefPatch, type PatchResult, refreshCapability } from "./merge.js";
/** Prompts of the interview_v3 route. */
export { interviewV3Messages, interviewV3System, type V3TurnInput } from "./prompt.js";
/** web_search / read_page of the interview with its own limits (C8 research). */
export { INTERVIEW_PAGE_CHARS, INTERVIEW_SEARCH_HITS, interviewResearchTools } from "./research-tools.js";
/** Constants, tool schemas and session types. */
export {
  type BriefPatch,
  briefPatchSchema,
  DEFAULT_RETENTION,
  DELEGATE_LABEL,
  DELEGATE_OPTION_ID,
  type DeferredQuestion,
  type ExtraRequirement,
  FINISH_LABEL,
  INTERVIEW_RESEARCH_LIMITS,
  INTERVIEW_V3_CALL_TYPE,
  type InterviewV3Session,
  MAX_V3_QUESTIONS,
  type NicheFact,
  V3_TOPIC_LABELS,
  V3_TOPICS,
  V3_TURN_MAX_CALLS,
  type V3Option,
  type V3Question,
  type V3QuestionInput,
  type V3State,
  type V3Topic,
  v3DeferInputSchema,
  v3FinishInputSchema,
  v3OptionSchema,
  v3QuestionInputSchema,
} from "./schemas.js";
/** Tolerant reading of the tools before zod. */
export { normalizeBriefPatchArgs, normalizeDeferArgs, normalizeQuestionArgs, topicOf } from "./tolerant.js";
