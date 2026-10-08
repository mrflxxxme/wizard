// @wizard/agents/brief-extract — ТЗ from a file (docx, pdf, md, txt) → a draft of the system brief (V3-04, D77 (8)):
// text extraction on the platform server, the T0 call brief_extract, the heuristic draft and briefGaps for the interview.

/** chunkText(text, max) → chunks along paragraph boundaries (a heading past half a chunk starts the next one). */
export { chunkText } from "./chunk.js";
/** decodeText(bytes) → {text, encoding}: BOM, UTF-16, UTF-8, Windows-1251 or KOI8-R; normalizeText for all formats. */
export { decodeText, looksLikeText, normalizeText, type TextEncodingName } from "./decode.js";
/** extractBriefDraft({text, route?}) → scrubbed valid draft (model per chunk via submit_brief_draft, else heuristic). */
export {
  BRIEF_DRAFT_TOOL,
  BRIEF_EXTRACT_CALL_TYPE,
  type BriefDraftAnswer,
  type BriefDraftMethod,
  type BriefDraftResult,
  briefDraftIssues,
  briefDraftSchema,
  briefDraftTool,
  briefExtractMessages,
  draftToBrief,
  extractBriefDraft,
  mergeBriefDraft,
  mergeBriefDrafts,
} from "./draft.js";
/** briefGaps(brief) → filled / partial / empty sections in interview order; BRIEF_DRAFT_TODO marks unanswered fields. */
export {
  BRIEF_BLOCKING_SECTIONS,
  BRIEF_DRAFT_TODO,
  BRIEF_GAP_SECTIONS,
  type BriefGapSection,
  type BriefGaps,
  type BriefSectionGap,
  type BriefSectionStatus,
  briefGaps,
  isDraftTodo,
} from "./gaps.js";
/** heuristicDraft(text) → goals and scenarios from headed lists, the rest empty (no model). */
export { heuristicDraft, sectionsOf } from "./heuristic.js";
/** readBriefFile(bytes) → {format, text, chars, truncated, pages?, encoding?}; the format by signature only. */
export { type BriefFileText, cutText, detectBriefFileFormat, readBriefFile } from "./read.js";
/** File limits (10 МБ, 60 МБ unpacked, 300 pdf pages, 120 000 characters) and BriefFileError (400/413/415). */
export {
  BRIEF_FILE_ERROR_CODES,
  BRIEF_FILE_FORMATS,
  BRIEF_FILE_LIMITS,
  BriefFileError,
  type BriefFileErrorCode,
  type BriefFileFormat,
} from "./types.js";
