// V4-24: the owner's manual edits of the draft after its last full build — instant edits (revisions by the user: texts,
// photos, the design's sliders) and «Укажи и измени» (revisions of point_edit runs). A rebuild makes the files from the
// harness's own layers, not from the draft, so it would replace them: «Собрать» asks first (REBUILD_REPLACES_EDITS).
import type { Kysely } from "kysely";
import type { DB } from "../../db/types.js";

/** How many revisions of the draft are the owner's manual edits made after the last full build (create/change). */
export async function manualEditsSinceBuild(db: Kysely<DB>, systemId: string): Promise<number> {
  const build = await db
    .selectFrom("platform.runs")
    .select("result_revision")
    .where("system_id", "=", systemId)
    .where("kind", "=", "build")
    .where("mode", "in", ["create", "change"])
    .where("status", "=", "succeeded")
    .where("result_revision", "is not", null)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!build?.result_revision) return 0;
  const row = await db
    .selectFrom("platform.revisions")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("system_id", "=", systemId)
    .where("version", ">", build.result_revision)
    .where((eb) =>
      eb.or([
        eb("author", "=", "user"),
        eb(
          "run_id",
          "in",
          eb
            .selectFrom("platform.runs")
            .select("id")
            .where("system_id", "=", systemId)
            .where("mode", "=", "point_edit"),
        ),
      ]),
    )
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
