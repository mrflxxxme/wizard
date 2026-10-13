// V4-18 «Без заглушек»: dead links and controls, placeholder texts, empty and repeated sections, contacts not from the
// brief — the static pass over the site's TSX and the page script for Chromium (the critic of V4-09 runs it next to its own).

/** STUB_CHECKS_SCRIPT defines window.__wzStubs.run(opts) in a page: the same codes, with a selector and a section. */
export { STUB_CHECKS_SCRIPT, type StubPageOptions, type StubPageResult } from "./page.js";
/** Codes S01–S04, their rubric (label, severity), the shared rules and the contacts the owner gave. */
export {
  deadLink,
  type KnownContacts,
  knownContacts,
  PLACEHOLDER_PATTERNS,
  PLACEHOLDER_TEXTS,
  phoneKey,
  placeholderOf,
  STUB_CODES,
  STUB_RUBRIC,
  type StubCode,
  type StubFinding,
  SYSTEM_ROUTES,
  strangeContacts,
} from "./rules.js";
/** stubFindings({files, known}) — the static pass over ui/pages and ui/sections (TSX) and ui/site.json. */
export { type SiteModel, STUB_FILES_RE, siteModel, stubFindings } from "./static.js";
