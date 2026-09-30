import type { AppSpec } from "@wizard/appspec";
import type { WzMap } from "./wz-id.js";

export type BuildEnv = "draft" | "prod";

/** specs/quality/gates.yaml#report.Check (structural copy: gates depends on build, not vice versa). */
export interface Check {
  id: string;
  status: "pass" | "fail" | "warn" | "skip" | "error";
  severity: "blocker" | "warning";
  message_ru: string;
  file?: string;
  line?: number;
  path?: string;
  acId?: string;
  evidence?: string;
  fixHint?: string;
}

/** Absolute entry files of the packages generated code may import (L3-13 allowlist). */
export interface HostModules {
  sdk: string;
  sdkJsxRuntime: string;
  uiKit: string;
  reactDomClient: string;
}

export interface BuildInput {
  spec: AppSpec;
  /** System-relative path → source; only ui/** and functions/** .ts/.tsx are used. */
  files: ReadonlyMap<string, string>;
  env: BuildEnv;
  /** Origin of platform-web that frames the draft preview. */
  platformOrigin?: string;
  /** Overrides of the default resolution (tests, alternative ui-kit builds). */
  hostModules?: Partial<HostModules>;
}

export interface BuildManifest {
  format: 1;
  env: BuildEnv;
  specHash: string;
  /** `<systemId>/<revision>` (platform/db.yaml revisions.bundle_key); set by writeArtifact. */
  bundleKey: string | null;
  /** sha256 over every emitted file: equal inputs → equal contentHash. */
  contentHash: string;
  entry: { script: string; style: string | null };
  client: Record<string, string>;
  functions: { file: "server/functions.mjs"; sha256: string; names: string[] };
  wzMap: boolean;
  sizes: { client: number; functions: number };
  esbuild: string;
}

export interface BuildResult {
  ok: boolean;
  errors: Check[];
  /** Paths relative to client/: index.html, assets/*. */
  client: Map<string, Uint8Array>;
  /** ESM: named export per function plus default {name: definition}; imports only @wizard/sdk. */
  serverFunctions: string;
  /** null for env=prod (no wz-map.json in prod, ui-kit.yaml#wz_id.prod). */
  wzMap: WzMap | null;
  manifest: BuildManifest;
  spec: AppSpec;
}
