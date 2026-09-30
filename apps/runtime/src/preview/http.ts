// Error mapping for connector-backed routes (/_wizard/qr, /api/pay, /_wizard/pay-mock).
import { isConnectorError } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import type { RuntimeContext } from "../http/context.js";
import { readJsonBody } from "../routes/data.js";

/** runtime.yaml#data_api.error_shape with an explicit status (codes outside the shared SDK table). */
export function jsonError(c: RuntimeContext, status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, details: {}, requestId: c.get("requestId") } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

const CONNECTOR_STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 422,
  SECRET_MISSING: 503,
  EGRESS_DISABLED: 503,
};

/** WizardError → rethrown (app.onError); ConnectorError → its code and Russian message; the rest → 500. */
export function connectorFailure(c: RuntimeContext, e: unknown): Response {
  if (e instanceof WizardError) throw e;
  if (isConnectorError(e)) {
    return jsonError(c, CONNECTOR_STATUS[e.code] ?? 502, e.code, e.message);
  }
  throw e;
}

/** JSON object body (≤ 1 MiB); anything else → 422 VALIDATION_FAILED. */
export async function readObjectBody(c: RuntimeContext): Promise<Record<string, unknown>> {
  const body = await readJsonBody(c);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WizardError("VALIDATION_FAILED", { message: "Ожидался JSON-объект" });
  }
  return body as Record<string, unknown>;
}
