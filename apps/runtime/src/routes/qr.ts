// /_wizard/qr/* (connectors/qr.yaml#endpoints): implemented by M0-24.
import type { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";
import { notImplemented } from "./stub.js";

export function qrRoutes(): Hono<RuntimeHonoEnv> {
  return notImplemented();
}
