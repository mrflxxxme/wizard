// V4-04: screenshots of the built site for the report — the home page at 390 (the first screen) and 1440 (the whole
// page), taken by the critic's inspector (the system built in process, the platform's photos and demo rows).

import type { GoalBrowserProvider } from "../../agents/goal-browser.js";
import type { BuildStore } from "../../runs/types.js";
import { type CriticInspectorOptions, criticInspector } from "../critic.js";

export interface SiteShot {
  width: 390 | 1440;
  mime: string;
  data: Uint8Array;
}

/** Every file of the draft's working tree (the build's last state). */
async function draftFiles(store: BuildStore): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of await store.listFiles()) {
    const src = await store.readFile(path);
    if (src !== null) files.set(path, src);
  }
  return files;
}

/** Screenshots 390 and 1440 of the home page; an error says why there are none. */
export async function siteShots(
  store: BuildStore,
  browser: GoalBrowserProvider,
  o: Omit<CriticInspectorOptions, "browser"> = {},
  signal?: AbortSignal,
): Promise<{ shots: SiteShot[]; error?: string }> {
  const { spec } = await store.getSpec();
  const files = await draftFiles(store);
  const inspect = criticInspector({ ...o, browser });
  const r = await inspect({
    spec,
    files,
    routes: ["/"],
    viewports: [
      { width: 390, height: 844, scheme: "light" },
      { width: 1440, height: 900, scheme: "light" },
    ],
    shots: [
      { route: "/", width: 390, kind: "screen", maxWidth: 390, maxHeight: 844 },
      { route: "/", width: 1440, kind: "page", maxWidth: 1440, maxHeight: 6000 },
    ],
    fonts: [],
    ...(signal ? { signal } : {}),
  });
  const shots = r.shots
    .filter((s) => s.width === 390 || s.width === 1440)
    .map((s) => ({
      width: s.width as 390 | 1440,
      mime: s.mime,
      data: new Uint8Array(Buffer.from(s.data, "base64")),
    }));
  return r.ok ? { shots } : { shots, error: r.error ?? "снимки не сняты" };
}
