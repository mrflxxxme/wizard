// @wizard/runtime — hosting of generated systems (specs/runtime/runtime.yaml).
export const APP = "@wizard/runtime";

/** DataAccess contract: data API + ctx.db/ctx.systemDb (architecture.yaml#interfaces.data_access). */
export * from "./data/access.js";
