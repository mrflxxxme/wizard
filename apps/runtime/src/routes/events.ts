// GET /api/events (runtime.yaml#realtime): SSE of invalidation events from DataAccess.events (in-process bus, M0).
// A session gets an event only when its role may read the entity; the id only without a rowFilter.
import { WizardError } from "@wizard/sdk";
import { compilePolicy } from "@wizard/sdk/host";
import { Hono } from "hono";
import type { InvalidationEvent } from "../data/access.js";
import type { RuntimeHonoEnv } from "../http/context.js";
import { sessionOf } from "../http/subject.js";

export const HEARTBEAT_MS = 25_000;
export const MAX_STREAMS_PER_SESSION = 3;

const open = new Map<string, number>();

export function eventsRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/", async (c) => {
    const { env } = c.get("services");
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== `${env.publicScheme}://${c.get("host")}`) {
      throw new WizardError("FORBIDDEN");
    }
    const sys = c.get("system");
    const { subject, token } = await sessionOf(c);
    const key = token === null ? null : `${sys.entry.systemId}:${sys.entry.env}:${token}`;
    if (key !== null) {
      const n = open.get(key) ?? 0;
      if (n >= MAX_STREAMS_PER_SESSION) {
        throw new WizardError("RATE_LIMITED", { message: "Открыто слишком много вкладок" });
      }
      open.set(key, n + 1);
    }

    const visibility = new Map<string, { read: boolean; withId: boolean }>();
    const visible = (entity: string) => {
      let v = visibility.get(entity);
      if (!v) {
        const p = compilePolicy(sys.spec, entity, subject);
        v = { read: p.allows("read"), withId: p.system || p.rowConstraint("read") === null };
        visibility.set(entity, v);
      }
      return v;
    };

    const enc = new TextEncoder();
    const signal = c.req.raw.signal;
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let done = false;
        const send = (s: string) => {
          if (done) return;
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {
            cleanup();
          }
        };
        const unsubscribe = sys.data.events.subscribe((e: InvalidationEvent) => {
          const v = visible(e.entity);
          if (!v.read) return;
          const data = v.withId ? { entity: e.entity, id: e.id, op: e.op } : { entity: e.entity, op: e.op };
          send(`event: invalidate\ndata: ${JSON.stringify(data)}\n\n`);
        });
        const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
        heartbeat.unref?.();
        cleanup = () => {
          if (done) return;
          done = true;
          unsubscribe();
          clearInterval(heartbeat);
          if (key !== null) {
            const n = (open.get(key) ?? 1) - 1;
            if (n <= 0) open.delete(key);
            else open.set(key, n);
          }
          try {
            ctrl.close();
          } catch {
            // already closed or errored
          }
        };
        signal.addEventListener("abort", () => cleanup(), { once: true });
        send(": ok\n\n");
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });
  return app;
}
