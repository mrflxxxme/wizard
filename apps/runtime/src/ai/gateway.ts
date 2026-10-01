// Client of the platform's AI gateway (runtime.yaml#ai_actions.call, M3-02): POST <platform>/internal/v1/ai/run with
// X-Wizard-Internal-Token. The platform routes the call to T0 only, enforces the monthly limit, the org credits and the
// platform LLM cap, and charges the org; the runtime only builds the request and writes the result.
import { WizardError } from "@wizard/sdk";

export type AiAttachmentMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export interface AiField {
  name: string;
  label: string;
  type: string;
  options?: { value: string; label: string }[];
  maxLength?: number;
  min?: number;
  max?: number;
}

/** Body of the gateway call (platform aiRunSchema). */
export interface AiRunRequest {
  systemKey: string;
  env: "draft" | "prod";
  callId: string;
  source: "button" | "workflow" | "backfill";
  monthlyLimit: number;
  action: { name: string; kind: "extract" | "generate"; instruction: string | null; outputs: AiField[] };
  record: { label: string; value: string }[];
  attachments?: { mime: AiAttachmentMime; data: string }[];
}

export interface AiRunResponse {
  values: Record<string, string | number | boolean>;
  skipped: string[];
  tier: "T0";
  model: string;
  creditsMilli: number;
}

export interface AiGatewayClient {
  run(req: AiRunRequest): Promise<AiRunResponse>;
}

/** Codes the gateway answers with that the runtime passes on to the caller (runtime.yaml#data_api.error_codes). */
const PASSED_ON = new Set(["AI_LIMIT_REACHED", "AI_CREDITS_EXHAUSTED", "AI_UNAVAILABLE"]);

/** HTTP client; any transport failure or unexpected answer is AI_UNAVAILABLE (503) for the end user. */
export function httpAiGateway(o: {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): AiGatewayClient {
  const doFetch = o.fetch ?? globalThis.fetch;
  return {
    async run(req) {
      let res: Response;
      try {
        res = await doFetch(new URL("/internal/v1/ai/run", o.url), {
          method: "POST",
          headers: { "content-type": "application/json", "x-wizard-internal-token": o.token },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
        });
      } catch {
        throw new WizardError("AI_UNAVAILABLE");
      }
      const body = (await res.json().catch(() => null)) as
        | (Partial<AiRunResponse> & { code?: string; message_ru?: string })
        | null;
      if (res.ok && body?.tier === "T0" && body.values && typeof body.values === "object")
        return body as AiRunResponse;
      // Anything but a T0 answer is refused here too (defence in depth: data-boundary.yaml#call_types).
      if (typeof body?.code === "string" && PASSED_ON.has(body.code))
        throw new WizardError(
          body.code,
          typeof body.message_ru === "string" ? { message: body.message_ru } : {},
        );
      throw new WizardError("AI_UNAVAILABLE");
    },
  };
}
