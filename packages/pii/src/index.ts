export const PACKAGE = "@wizard/pii";

export {
  cardIinAllowed,
  innOrgValid,
  innPersonValid,
  innValid,
  isCardNumber,
  luhnValid,
  ogrnipValid,
  snilsControl,
  snilsValid,
} from "./checksums.js";
export { classifyFieldName, type FieldClassification } from "./classify.js";
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
/** V3-21: access keys typed as text — provider formats and high-entropy tokens near «ключ»/«token»/«api»; masking. */
export {
  detectSecrets,
  hasSecret,
  maskSecrets,
  replaceSecrets,
  SECRET_MASK,
  type SecretDetectOptions,
  type SecretFinding,
  type SecretKind,
} from "./secrets.js";
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
  type PiiKind,
  PLACEHOLDER_RE,
  STRONG_KINDS,
  toPiiKind,
} from "./types.js";
