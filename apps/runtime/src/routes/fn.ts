// POST /api/fn/:name (runtime.yaml#functions): implemented by M0-23 over DataAccess.runner() + createFunctionHost.
import type { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";
import { notImplemented } from "./stub.js";

export function fnRoutes(): Hono<RuntimeHonoEnv> {
  return notImplemented();
}
