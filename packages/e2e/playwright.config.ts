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
    // Vite starts before platform-api listens: wait for the API through the platform-web proxy (both up);
    // runtime is polled by the specs themselves.
    url: "http://127.0.0.1:5173/api/v1/systems",
    reuseExistingServer: !ci,
    timeout: 120_000,
    stdout: "pipe",
    gracefulShutdown: { signal: "SIGINT", timeout: 10_000 },
    // Local-only switches from .env.example: dev-login in the draft preview and functions in unsafe-local mode
    // (runtime.yaml#auth.dev_login_M0, #functions.M0_M1); dev.mjs binds every service to 127.0.0.1.
    env: {
      WIZARD_LLM_MODE: "fixture",
      WIZARD_FIXTURE: "demo/forum",
      WIZARD_AUTH_MODE: "dev",
      WIZARD_DEV_LOGIN: "1",
      WIZARD_UNSAFE_LOCAL_EXEC: "1",
    },
  },
});
