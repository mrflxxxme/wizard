// Shared 501 handler for routes implemented by later tasks.
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";

export function notImplemented(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.all("*", () => {
    throw new WizardError("NOT_IMPLEMENTED");
  });
  return app;
}
