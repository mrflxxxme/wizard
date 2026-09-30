// @wizard/build — specs/architecture.yaml#interfaces.build_system.
export const PACKAGE = "@wizard/build";

export { type WrittenArtifact, writeArtifact } from "./artifact.js";
export {
  BUILD_CHECK_ID,
  buildSystem,
  defaultHostModules,
  SYSTEM_BUNDLE_LIMIT,
  UI_BUNDLE_LIMIT,
} from "./build.js";
export { canonicalJson, sha256Hex, specHash } from "./hash.js";
export { type SystemTsconfig, systemTsconfig, TSCONFIG_SYSTEM_PATH } from "./tsconfig.js";
export type {
  BuildEnv,
  BuildInput,
  BuildManifest,
  BuildResult,
  Check,
  HostModules,
} from "./types.js";
export { fileKey, injectWzIds, type WzEntry, type WzMap, type WzTransform } from "./wz-id.js";
