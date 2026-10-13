// V4-15 «Укажи и измени» of a v3 system (builder.yaml#point_and_edit, run mode point_edit): the agent rewrites only the
// file of the clicked element (packages/agents builder/v3/edit), the file is committed, G0 and G1 check it; G0's
// problems go back to the agent once, then the file returns to what it was and the run fails with the reason. The
// revision's diff is exactly {target.file}.
import { erroredBlockers, failedBlockers, pointEditV3 } from "@wizard/agents/builder";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import { type BuildHost, type HostRouteInput, type PointEditTarget, RunFailure } from "../../runs/types.js";

/** Rounds of the agent: the first answer and one repair by the gates' problems. */
export const POINT_EDIT_ROUNDS = 2;

export async function pointEditBuild(
  host: BuildHost,
  target: PointEditTarget,
): Promise<{ status: "succeeded"; summary_ru: string }> {
  const original = await host.store.readFile(target.file);
  if (original === null)
    throw new RunFailure(
      "GATES_FAILED",
      "Файла этого элемента уже нет — обновите превью и выберите его снова",
      false,
    );
  // The host adds the run's context and budget; the agent's route only carries the call.
  const route = (ri: RouteInput): Promise<RouteOutput> => {
    const { ctx: _ctx, orgPolicy: _policy, signal: _signal, ...rest } = ri;
    return host.route(rest as HostRouteInput);
  };
  let problems: string[] = [];
  for (let round = 1; round <= POINT_EDIT_ROUNDS; round++) {
    const r = await host.runStep(`point_edit:${round}`, () =>
      pointEditV3({
        input: { target, source: original, ...(problems.length ? { problems } : {}) },
        route,
        ...(host.signal ? { signal: host.signal } : {}),
      }),
    );
    if (!r.ok) {
      problems = [r.reason];
      continue;
    }
    await host.store.writeFile(target.file, r.source);
    await host.store.commitFiles();
    const g0 = await host.runGates("G0");
    const bad = [...failedBlockers(g0), ...erroredBlockers(g0)].map((c) => c.message_ru);
    if (bad.length) {
      problems = bad.slice(0, 8);
      continue;
    }
    await host.runGates("G1");
    return { status: "succeeded", summary_ru: r.summary };
  }
  // Nothing passed: the file returns to what it was (a revision of its own, so the preview matches the draft).
  if ((await host.store.readFile(target.file)) !== original) {
    await host.store.writeFile(target.file, original);
    await host.store.commitFiles();
    await host.runGates("G0");
  }
  throw new RunFailure(
    "GATES_FAILED",
    `Не получилось изменить элемент так, чтобы система прошла проверку: ${problems[0] ?? "ответ модели не подошёл"}. Опишите правку иначе или поправьте в чате.`,
    true,
  );
}
