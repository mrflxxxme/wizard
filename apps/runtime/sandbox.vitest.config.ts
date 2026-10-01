// Vitest project of the CI job `sandbox` (.github/workflows/sandbox.yml): real workerd and gVisor. Every suite in it
// is skipped unless WIZARD_SANDBOX_E2E=1; run with `vitest run --config apps/runtime/sandbox.vitest.config.ts`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sandbox",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.sandbox.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
