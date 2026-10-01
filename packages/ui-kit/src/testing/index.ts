// @wizard/ui-kit/testing: memory DataSource with runtime permission semantics for demo and tests.
export { toRoleSpec } from "../data/roleSpec.js";
export { fieldProblem } from "../data/validate.js";
/** Offline scanner core (package, local check, queue, sync) with memory storage for tests. */
export { memoryStorage, OfflineScanner, offlineHash, payloadRand } from "../qr/offline.js";
export {
  createMemoryDataSource,
  type MemoryAiAction,
  type MemoryCall,
  type MemoryDataSource,
  type MemoryFn,
  type MemoryFnCtx,
  type MemoryOptions,
  type MemoryOutboxMessage,
  type MemoryUser,
  memoryQrToken,
  wzError,
} from "./memory.js";
