// @wizard/agents/core: tool loop, zod → JSON Schema tool definitions, loop events.
export { AgentError, type AgentErrorCode } from "./errors.js";
export { type AgentEvent, type AgentEventSink, type EmitFn, identityStep, type RunStepFn } from "./events.js";
export {
  type CallBase,
  type CallStats,
  callTool,
  DEFAULT_MAX_REPAIRS,
  MAX_PARALLEL_TOOL_CALLS,
  type RouteFn,
  runToolLoop,
  type StructuredResult,
  type ToolLoopResult,
} from "./loop.js";
export {
  defineTool,
  type Tool,
  type ToolErrorResult,
  ToolFailure,
  type ToolIssue,
  type ToolSpec,
  toJsonSchema,
  toolError,
  zodIssues,
} from "./tool.js";
