// Hono environment shared by runtime routes (src/routes/*): the resolved system and request metadata.
import type { Context } from "hono";
import type { Subject } from "../data/access.js";
import type { RuntimeEnv } from "../env.js";
import type { LoadedSystem } from "../system.js";

export interface OutboxMessage {
  integration: string;
  action: string;
  /** Recipient userId (never a contact: the host resolves it). */
  userId?: string | null;
  payload: unknown;
  at: string;
}

/** Services available to routes (set once per app). */
export interface RuntimeServices {
  env: RuntimeEnv;
  clock: () => Date;
  connectors: "outbox" | "live";
  outbox: OutboxMessage[];
  /** JSON log sink of createRuntimeApp (runtime.yaml#logging). */
  log?: (line: Record<string, unknown>) => void;
}

export interface RuntimeVars {
  requestId: string;
  services: RuntimeServices;
  /** Host header as sent (with port): the only accepted Origin is <scheme>://<host>. */
  host: string;
  system: LoadedSystem;
}

export type RuntimeHonoEnv = { Variables: RuntimeVars };
export type RuntimeContext = Context<RuntimeHonoEnv>;

/** Session → Subject for API routes (runtime.yaml#permissions.algorithm step 1); cached per request. */
export type SubjectResolver = (c: RuntimeContext) => Promise<Subject>;
