// Hono environment shared by runtime routes (src/routes/*): the resolved system and request metadata.
import type { Context } from "hono";
import type { AiGatewayClient } from "../ai/gateway.js";
import type { Subject } from "../data/access.js";
import type { RuntimeEnv } from "../env.js";
import type { ConnectorHost } from "../preview/connectors.js";
import type { LegalTemplates } from "../privacy/templates.js";
import type { EgressService } from "../sandbox/egress-service.js";
import type { SandboxExecutors } from "../sandbox/workerd-executor.js";
import type { LoadedSystem } from "../system.js";

export interface OutboxMessage {
  integration: string;
  action: string;
  /** Recipient userId (never a contact: the host resolves it). */
  userId?: string | null;
  payload: unknown;
  at: string;
  /** systemId of the sender (G1: a gate reads only the messages of its own systems). */
  system?: string;
}

/** Services available to routes (set once per app). */
export interface RuntimeServices {
  env: RuntimeEnv;
  clock: () => Date;
  connectors: "outbox" | "live";
  outbox: OutboxMessage[];
  /** JSON log sink of createRuntimeApp (runtime.yaml#logging). */
  log?: (line: Record<string, unknown>) => void;
  /** Connector contexts of loaded systems (connectors: 'live' routes action calls through @wizard/connectors). */
  connectorHost?: ConnectorHost;
  /** HMAC of the client network of a request (consent journal); null when unknown. */
  ipHmac?: (req: Request) => Buffer | null;
  /** 152-ФЗ package settings (privacy/erasure.ts). */
  privacy?: PrivacySettings;
  /** Lawyer's templates of the policy page and consent texts (privacy/templates.ts). */
  legalTemplates?: LegalTemplates;
  /** M2 sandbox executors (workerd in gVisor, security/isolation.yaml#M2); absent → unsafe-local or disabled. */
  sandbox?: SandboxExecutors;
  /** M3-02: the platform's AI gateway (runtime.yaml#ai_actions.call); null/absent → AI actions answer 503. */
  ai?: AiGatewayClient | null;
  /** M2-52: ctx.http.fetch of functions (egress proxy or direct after the address check); absent → EGRESS_DISABLED. */
  egress?: EgressService;
}

export interface PrivacySettings {
  /** Days between consent withdrawal and anonymization (0 — at once; at most 30, ст. 21 ч. 5). */
  withdrawalDays: number;
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
