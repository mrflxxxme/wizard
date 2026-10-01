// /runs/* operations of specs/platform/api.yaml (x-milestone M0); SSE per streamRunEvents.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Selectable } from "kysely";
import { z } from "zod";
import type { RunsTable } from "../db/types.js";
import { invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { INTERNAL_EVENTS, listEvents, TERMINAL_EVENTS } from "../runs/events.js";
import { TERMINAL_STATUSES } from "../runs/queue.js";
import { toRun } from "../services/serialize.js";

export const PING_MS = 15_000;

export function runRoutes(d: Deps, opts: { pingMs?: number } = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function loadRun(
    user: AuthUser,
    id: string | undefined,
    min: OrgRole,
  ): Promise<Selectable<RunsTable>> {
    if (!isUuid(id)) throw notFound("Прогон");
    const run = await d.db.selectFrom("platform.runs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!run) throw notFound("Прогон");
    checkOrgAccess(user, run.org_id, min, "Прогон");
    return run;
  }

  async function runJson(id: string) {
    const run = await d.db
      .selectFrom("platform.runs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const { last } = await d.db
      .selectFrom("platform.run_events")
      .select((eb) => eb.fn.coalesce(eb.fn.max("seq"), eb.lit(0)).as("last"))
      .where("run_id", "=", id)
      .executeTakeFirstOrThrow();
    return toRun(run, Number(last));
  }

  r.get("/runs/:id", async (c) => {
    const run = await loadRun(c.get("user"), c.req.param("id"), "viewer");
    return c.json(await runJson(run.id));
  });

  r.get("/runs/:id/events", async (c) => {
    const run = await loadRun(c.get("user"), c.req.param("id"), "viewer");
    const afterQ = c.req.query("after");
    const lastId = c.req.header("last-event-id");
    const parse = (v: string | undefined) => {
      if (v === undefined || v === "") return 0;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw invalid("after и Last-Event-ID — целые числа ≥ 0");
      return n;
    };
    let last = Math.max(parse(afterQ), parse(lastId));
    return streamSSE(c, async (stream) => {
      let done = false;
      let dirty = true;
      let terminalSeen = false;
      let wake: (() => void) | null = null;
      const unsubscribe = d.bus.subscribe(run.id, () => {
        dirty = true;
        wake?.();
      });
      const ping = setInterval(() => {
        stream.write(": ping\n\n").catch(() => {});
      }, opts.pingMs ?? PING_MS);
      stream.onAbort(() => {
        done = true;
        wake?.();
      });
      try {
        while (!done) {
          if (!dirty) {
            const poll = d.eventPollMs ?? 0;
            await new Promise<void>((res) => {
              wake = res;
              if (poll > 0)
                setTimeout(() => {
                  dirty = true;
                  res();
                }, poll).unref();
            });
            wake = null;
            continue;
          }
          dirty = false;
          const events = await listEvents(d.db, run.id, last);
          for (const e of events) {
            last = e.seq;
            if (!INTERNAL_EVENTS.has(e.type))
              await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
            if (TERMINAL_EVENTS.has(e.type)) {
              done = true;
              break;
            }
          }
          if (!done && events.length === 0) {
            const cur = await d.db
              .selectFrom("platform.runs")
              .select("status")
              .where("id", "=", run.id)
              .executeTakeFirstOrThrow();
            // Terminal status seen: one more read (the terminal event is committed with it), then close.
            if (TERMINAL_STATUSES.has(cur.status)) {
              if (terminalSeen) done = true;
              else terminalSeen = dirty = true;
            }
          }
        }
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });

  r.post("/runs/:id/cancel", async (c) => {
    const run = await loadRun(c.get("user"), c.req.param("id"), "editor");
    await d.engine.cancel(run.id);
    return c.json(await runJson(run.id), 202);
  });

  r.post("/runs/:id/input", async (c) => {
    const run = await loadRun(c.get("user"), c.req.param("id"), "editor");
    const b = await jsonBody(
      c,
      z.strictObject({
        inputId: z.string().min(1).max(200),
        choice: z.string().max(200).optional(),
        text: z.string().max(2000).optional(),
        secretValue: z.string().max(4096).optional(),
      }),
    );
    if (b.text !== undefined && b.choice === undefined)
      throw invalid("Свой ответ отправляется вместе с вариантом");
    await d.engine.provideInput(run.id, b);
    return c.json(await runJson(run.id), 202);
  });

  return r;
}
