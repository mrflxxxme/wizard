export const APP = "@wizard/platform-api";

export { createPlatformApi, type PlatformApi, type PlatformApiOptions } from "./app.js";
export { type Config, loadConfig } from "./config.js";
export {
  createDb,
  type Db,
  type DbHandle,
  DEFAULT_ORG_ID,
  DEV_USER_EMAIL,
  DEV_USER_ID,
  migrate,
  seed,
} from "./db/index.js";
export { ApiError, ERROR_STATUS, type ErrorCode } from "./errors.js";
export { EVENT_TYPES, type EventType, INTERNAL_EVENTS, type RunEvent } from "./runs/events.js";
export { gateResultPayload, recordGateReport } from "./runs/gates.js";
export { RunEngine } from "./runs/queue.js";
export { stubExecutors } from "./runs/stub.js";
export * from "./runs/types.js";
export { IllegalTransition, STAGES, type Stage } from "./services/stage.js";
