import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { M1, M2, PILOT } from "./stand/ports.js";

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
  projects: [
    // M0 dev stand (scripts/dev.mjs, WIZARD_AUTH_MODE=dev, fixture LLM).
    // rehearsal/: a deployed environment only (playwright.rehearsal.config.ts), never the dev stand.
    { name: "chromium", testIgnore: /(m[12]|pilot|rehearsal)\//, use: { ...devices["Desktop Chrome"] } },
    // M1 stand (stand/m1.ts): session auth (email OTP, dev-login for setup), scripted builder, real publish.
    {
      name: "m1",
      testMatch: /m1\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${M1.web}`, locale: "ru-RU" },
    },
    // M2 stand (stand/m2.ts): WIZARD_MILESTONE=M2 rules (card binding before prod) and the platform shop on
    // YookassaMock with a test checkout page (M2-11).
    {
      name: "m2",
      testMatch: /m2\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${M2.web}`, locale: "ru-RU" },
    },
    // Pilot stand (stand/pilot.ts, M2-15): invite-only registration, payments off, prod without a card.
    {
      name: "pilot",
      testMatch: /pilot\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${PILOT.web}`, locale: "ru-RU" },
    },
  ],
  webServer: [
    {
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
        // D78: v3 is the default; these specs walk the v1 card flow on its recorded answers.
        WIZARD_BUILD_PIPELINE: "legacy",
        WIZARD_AUTH_MODE: "dev",
        WIZARD_DEV_LOGIN: "1",
        WIZARD_UNSAFE_LOCAL_EXEC: "1",
      },
    },
    {
      command: `pnpm exec tsx ${JSON.stringify(join(import.meta.dirname, "stand", "m1.ts"))}`,
      cwd: import.meta.dirname,
      // 401 without a session means platform-api answers through the Vite proxy (both up).
      url: `http://127.0.0.1:${M1.web}/api/v1/me`,
      reuseExistingServer: !ci,
      timeout: 120_000,
      stdout: "pipe",
      gracefulShutdown: { signal: "SIGINT", timeout: 15_000 },
      env: { WIZARD_LLM_MODE: "fixture", WIZARD_BUILD_PIPELINE: "legacy" },
    },
    {
      command: `pnpm exec tsx ${JSON.stringify(join(import.meta.dirname, "stand", "m2.ts"))}`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${M2.web}/api/v1/me`,
      reuseExistingServer: !ci,
      timeout: 120_000,
      stdout: "pipe",
      gracefulShutdown: { signal: "SIGINT", timeout: 15_000 },
      env: { WIZARD_LLM_MODE: "fixture", WIZARD_BUILD_PIPELINE: "legacy" },
    },
    {
      command: `pnpm exec tsx ${JSON.stringify(join(import.meta.dirname, "stand", "pilot.ts"))}`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${PILOT.web}/api/v1/me`,
      reuseExistingServer: !ci,
      timeout: 120_000,
      stdout: "pipe",
      gracefulShutdown: { signal: "SIGINT", timeout: 15_000 },
      env: { WIZARD_LLM_MODE: "fixture", WIZARD_BUILD_PIPELINE: "legacy" },
    },
  ],
});
