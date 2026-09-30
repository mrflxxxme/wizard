// writeArtifact: runtime.yaml#system_loading.artifact_layout —
// <root>/<systemId>/<revision>/{spec.json, manifest.json, client/…, server/functions.mjs, wz-map.json (draft)}.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "./hash.js";
import type { BuildManifest, BuildResult } from "./types.js";

const SYSTEM_ID_RE = /^[a-z0-9]{12}$/;
const CLIENT_PATH_RE = /^(?:index\.html|assets\/[A-Za-z0-9_.-]+)$/;

export interface WrittenArtifact {
  dir: string;
  bundleKey: string;
  manifest: BuildManifest;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

/**
 * Revisions are immutable: rewriting the same build is a no-op, a different build under an existing
 * revision throws. Files are staged in a sibling directory and renamed into place atomically.
 */
export function writeArtifact(
  root: string,
  systemId: string,
  revision: number,
  result: BuildResult,
): WrittenArtifact {
  if (!result.ok) throw new Error("writeArtifact: build failed, nothing to write");
  if (!SYSTEM_ID_RE.test(systemId))
    throw new Error(`writeArtifact: invalid systemId ${JSON.stringify(systemId)}`);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error(`writeArtifact: invalid revision ${revision}`);
  for (const p of result.client.keys()) {
    if (!CLIENT_PATH_RE.test(p)) throw new Error(`writeArtifact: invalid client path ${JSON.stringify(p)}`);
  }

  const bundleKey = `${systemId}/${revision}`;
  const manifest: BuildManifest = { ...result.manifest, bundleKey };
  const dir = join(root, systemId, String(revision));
  if (existsSync(dir)) {
    const prev = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BuildManifest;
    if (prev.contentHash === manifest.contentHash && prev.specHash === manifest.specHash) {
      return { dir, bundleKey, manifest: prev };
    }
    throw new Error(`writeArtifact: revision ${bundleKey} already exists with different content`);
  }

  const stage = join(root, systemId, `.${revision}.tmp-${process.pid}-${Date.now()}`);
  const put = (rel: string, data: string | Uint8Array) => {
    const abs = join(stage, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  };
  try {
    put("spec.json", pretty(result.spec));
    for (const [p, data] of result.client) put(join("client", p), data);
    put("server/functions.mjs", result.serverFunctions);
    if (manifest.env === "draft" && result.wzMap)
      put("wz-map.json", `${JSON.stringify(result.wzMap, null, 2)}\n`);
    put("manifest.json", pretty(manifest));
    renameSync(stage, dir);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return { dir, bundleKey, manifest };
}
