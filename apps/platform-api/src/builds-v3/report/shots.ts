// V4-04: screenshots of the built site for the report — the home page at 390 (the first screen) and 1440 (the whole
// page), taken by the critic's inspector (the system built in process, the platform's photos and demo rows).

import { siteModel } from "@wizard/gates";
import type { GoalBrowserProvider } from "../../agents/goal-browser.js";
import type { BuildStore } from "../../runs/types.js";
import { type CriticInspectorOptions, criticInspector } from "../critic.js";

/** Pages shot at most (the report stays small). */
export const SHOT_PAGES_MAX = 12;

export interface SiteShot {
  /** Route of the page; the home page first. */
  route: string;
  width: 390 | 1440;
  mime: string;
  data: Uint8Array;
}

/** Every file of the draft's working tree (the build's last state). */
export async function draftFiles(store: BuildStore): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of await store.listFiles()) {
    const src = await store.readFile(path);
    if (src !== null) files.set(path, src);
  }
  return files;
}

/** Routes of the built site's pages, the home page first (V5-10); a site without a model — the home page only. */
export function shotRoutes(files: ReadonlyMap<string, string>): string[] {
  const routes = (siteModel(files)?.pages ?? []).map((p) => p.route).filter((r) => r.startsWith("/"));
  const uniq = [...new Set(["/", ...routes])];
  return uniq.slice(0, SHOT_PAGES_MAX);
}

/** Screenshots 390 and 1440 of every page of the site (V5-10); an error says why there are none. */
export async function siteShots(
  store: BuildStore,
  browser: GoalBrowserProvider,
  o: Omit<CriticInspectorOptions, "browser"> = {},
  signal?: AbortSignal,
): Promise<{ shots: SiteShot[]; error?: string }> {
  const { spec } = await store.getSpec();
  const files = await draftFiles(store);
  const routes = shotRoutes(files);
  const inspect = criticInspector({ ...o, browser });
  const r = await inspect({
    spec,
    files,
    routes,
    viewports: [
      { width: 390, height: 844, scheme: "light" },
      { width: 1440, height: 900, scheme: "light" },
    ],
    shots: routes.flatMap((route) => [
      { route, width: 390 as const, kind: "screen" as const, maxWidth: 390, maxHeight: 844 },
      { route, width: 1440 as const, kind: "page" as const, maxWidth: 1440, maxHeight: 6000 },
    ]),
    fonts: [],
    ...(signal ? { signal } : {}),
  });
  const shots = r.shots
    .filter((s) => s.width === 390 || s.width === 1440)
    .map((s) => ({
      route: s.route,
      width: s.width as 390 | 1440,
      mime: s.mime,
      data: new Uint8Array(Buffer.from(s.data, "base64")),
    }));
  return r.ok ? { shots } : { shots, error: r.error ?? "снимки не сняты" };
}
