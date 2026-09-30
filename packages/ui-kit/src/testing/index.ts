// @wizard/ui-kit/testing: memory DataSource with runtime permission semantics for demo and tests.
export { toRoleSpec } from "../data/roleSpec.js";
export { fieldProblem } from "../data/validate.js";
export {
  createMemoryDataSource,
  type MemoryCall,
  type MemoryDataSource,
  type MemoryFn,
  type MemoryFnCtx,
  type MemoryOptions,
  type MemoryOutboxMessage,
  type MemoryUser,
  wzError,
} from "./memory.js";
