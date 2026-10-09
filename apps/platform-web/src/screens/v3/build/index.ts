// V3-17 the live v3 build on the canvas: the canvas calls useV3Live and places what it returns.
/** useV3Live({systemId, name, events, announce}) → main (panel + growing system), ready dock, toast, spend, time left. */
export { LivePreview, type UseV3LiveOptions, useV3Live, V3LivePanel, type V3LiveView } from "./LiveBuild.js";
/** Pure model of the run events: v3Live(events) — the latest snapshot, gates, phase; liveClock; the replayed run. */
export {
  isV3Progress,
  lastReportRun,
  liveClock,
  scenarioCount,
  type V3Live,
  type V3LiveClock,
  type V3LiveGate,
  type V3LivePhase,
  v3Live,
  v3SpendLine,
} from "./live.js";
/** The browser notice of a ready build (Notification API with the owner's permission). */
export { askNotify, firstNotice, type NotifyState, notifyState, showNotice } from "./notify.js";
/** Russian texts of the live build. */
export { liveRu } from "./ru.js";
