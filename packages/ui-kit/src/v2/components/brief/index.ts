// «Бриф» components of the platform v2 (V3-06, D77 (9)): the short brief in the chat, the panel with versions and
// difference, the diagrams drawn by our own layout, the editor and the session feed.
export { BriefDiagram, type BriefDiagramProps } from "./BriefDiagram.js";
export { BriefDiffView, type BriefDiffViewProps } from "./BriefDiffView.js";
export {
  BRIEF_EDITABLE_SECTIONS,
  type BriefEditableSection,
  BriefEditor,
  type BriefEditorProps,
} from "./BriefEditor.js";
export { BriefPanel, type BriefPanelProps, type BriefPanelTab, type BriefVersionInfo } from "./BriefPanel.js";
export {
  BRIEF_DIAGRAM_KEYS,
  type BriefDiagramKey,
  BriefSummary,
  type BriefSummaryProps,
} from "./BriefSummary.js";
export {
  BRIEF_LAYOUT,
  type GraphLayout,
  type LaidEdge,
  type LaidNode,
  type LayoutOptions,
  layoutBriefGraph,
  overlaps,
  textWidth,
  wrapText,
} from "./layout.js";
export {
  type BriefSession,
  SESSION_KINDS,
  SESSION_STATUS_RU,
  SESSION_STATUSES,
  SessionsFeed,
  type SessionsFeedProps,
  sessionTitle,
} from "./SessionsFeed.js";
export { briefTheses, changedKeys, itemKey } from "./text.js";
