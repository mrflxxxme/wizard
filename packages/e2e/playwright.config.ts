import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Local containers ship chromium in /opt/pw-browsers (revision pinned by the exact @playwright/test version);
// CI runs `playwright install --with-deps chromium` and uses the default cache.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
}

const root = join(import.meta.dirname, "..", "..");
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "specs",
  timeout: 30_000,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ${JSON.stringify(join(root, "scripts", "dev.mjs"))}`,
    cwd: root,
    // platform-web answers last in dev.mjs order; api and runtime are polled by the specs themselves.
    url: "http://127.0.0.1:5173/",
    reuseExistingServer: !ci,
    timeout: 120_000,
    stdout: "pipe",
    gracefulShutdown: { signal: "SIGINT", timeout: 10_000 },
    env: { WIZARD_LLM_MODE: "fixture" },
  },
});
