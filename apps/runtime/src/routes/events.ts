// GET /api/events (runtime.yaml#realtime): implemented by M0-23 over DataAccess.events.
import type { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";
import { notImplemented } from "./stub.js";

export function eventsRoutes(): Hono<RuntimeHonoEnv> {
  return notImplemented();
}
