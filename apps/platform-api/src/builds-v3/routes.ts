// POST /systems/:id/brief/approve (V3-06, api.yaml approveSystemBrief): «Собрать» of a v3 system — the one approval
// point (D7, D77 (9)) — on the service startV3Build of V3-11: the build by the brief version the owner saw, with the
// credits cap of a v3 build (V3_BUILD_CAP_CREDITS, 500 ₽, D77 (11)). Editor and up; another org's system is 404; a
// build already running is 409 SYSTEM_LOCKED; a newer brief than the one approved is 412 VERSION_CONFLICT. A repeat
// with the same Idempotency-Key gets the same answer (http/idempotency.ts).
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { TERMINAL_STATUSES } from "../runs/queue.js";
import { toRun } from "../services/serialize.js";
import { IllegalTransition } from "../services/stage.js";
import { V3_BUILD_CAP_CREDITS } from "./host.js";
import { startV3Build } from "./start.js";

const LOCKED = () => new ApiError("SYSTEM_LOCKED", "Идёт сборка — дождитесь её окончания");

export function buildV3Routes(d: Pick<Deps, "db" | "bus" | "engine" | "billing">): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/systems/:id/brief/approve", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "stage"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, "editor", "Система");
    const b = await jsonBody(c, z.strictObject({ version: z.number().int().min(1) }));
    const lock = await d.db
      .selectFrom("platform.locks")
      .select("run_id")
      .where("system_id", "=", s.id)
      .where("lease_until", ">", new Date())
      .executeTakeFirst();
    const active = await d.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", s.id)
      .where("kind", "=", "build")
      .where("status", "not in", [...TERMINAL_STATUSES])
      .executeTakeFirst();
    if (lock || active || s.stage === "building") throw LOCKED();
    try {
      const run = await startV3Build(d, { systemId: s.id, userId: user.id, briefVersion: b.version });
      return c.json({ run: toRun(run, 0), capCredits: V3_BUILD_CAP_CREDITS }, 202);
    } catch (e) {
      if (e instanceof IllegalTransition) throw LOCKED();
      throw e;
    }
  });

  return r;
}
