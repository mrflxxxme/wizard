export const PACKAGE = "@wizard/pii";

export { cardIinAllowed, innOrgValid, innPersonValid, innValid, isCardNumber, luhnValid, snilsControl, snilsValid } from "./checksums.js";
export { type FieldClassification, classifyFieldName } from "./classify.js";
export { type DetectOptions, detect } from "./detect.js";
export { normalizePhoneRu } from "./detectors/phone.js";
export { detectSpecialTerms } from "./detectors/special.js";
export {
  type ScrubJsonResult,
  type ScrubMessagesResult,
  type ScrubResult,
  type ScrubSummary,
  scrub,
  scrubJson,
  scrubMessages,
} from "./scrub.js";
export {
  type Category,
  type Confidence,
  type Finding,
  isPlaceholder,
  KIND_INFO,
  KINDS,
  type Kind,
  type KindInfo,
  maxCategory,
  PLACEHOLDER_RE,
  type PiiKind,
  STRONG_KINDS,
  toPiiKind,
} from "./types.js";
