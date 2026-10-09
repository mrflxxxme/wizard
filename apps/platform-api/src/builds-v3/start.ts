// «Собрать» of a v3 system (V3-11; D77 (9): the brief is the one approval point, D7): a build run by the latest brief
// with the credits cap of a v3 build (500 ₽, D77 (11)). The route of the brief panel (V3-06) calls it; the executor
// sends the run to the harness v3 (agents/executors.ts, WIZARD_BUILD_PIPELINE=v3).
import { getLatestBrief } from "../briefs/store.js";
import { ApiError } from "../errors.js";
import type { Deps } from "../http/util.js";
import { withTx } from "../runs/events.js";
import { insertRun } from "../runs/queue.js";
import { lockSystem } from "../services/revisions.js";
import { assertTransition } from "../services/stage.js";
import { V3_BUILD_CAP_CREDITS } from "./host.js";

/**
 * Starts a v3 build of a system: under the systems row lock — a brief exists (else 409 NO_PLAN), the stage moves to
 * building (a system still in the interview passes the approval «card» on the way), the run carries the brief version
 * it was started on. Returns the enqueued run.
 */
export async function startV3Build(
  d: Pick<Deps, "db" | "bus" | "engine" | "billing">,
  p: {
    systemId: string;
    userId: string;
    /** V3-06: the brief version the owner approved; another latest version → 412 VERSION_CONFLICT. */
    briefVersion?: number;
  },
) {
  const run = await withTx(d.db, d.bus, async (t) => {
    const s = await lockSystem(t, p.systemId);
    const brief = await getLatestBrief(t.trx, s.id);
    if (!brief)
      throw new ApiError(
        "NO_PLAN",
        "У системы ещё нет брифа — ответьте на вопросы интервью, потом нажмите «Собрать»",
      );
    if (p.briefVersion !== undefined && p.briefVersion !== brief.version)
      throw new ApiError(
        "VERSION_CONFLICT",
        "Бриф изменился — посмотрите новую версию и нажмите «Собрать» ещё раз",
        {
          version: brief.version,
        },
      );
    const from = s.stage === "interview" ? assertTransition(s.stage, "card") : s.stage;
    await t.trx
      .updateTable("platform.systems")
      .set({
        stage: assertTransition(from, "building"),
        updated_at: new Date(),
        last_activity_at: new Date(),
      })
      .where("id", "=", s.id)
      .execute();
    return insertRun(
      t,
      {
        orgId: s.org_id,
        systemId: s.id,
        kind: "build",
        mode: s.preview_revision !== null ? "change" : "create",
        input: { pipeline: "v3", briefVersion: brief.version },
        capMilli: V3_BUILD_CAP_CREDITS * 1000,
        startedBy: p.userId,
      },
      d.billing,
    );
  });
  d.engine.enqueue(run);
  return run;
}
