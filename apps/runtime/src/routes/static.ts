// Bundle static files, SPA fallback, /login and the policy page (runtime.yaml#static, #routing.rules): M0-24.
import type { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";
import { notImplemented } from "./stub.js";

export function staticRoutes(): Hono<RuntimeHonoEnv> {
  return notImplemented();
}
