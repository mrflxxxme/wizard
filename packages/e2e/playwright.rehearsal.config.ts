import { defineConfig, devices } from "@playwright/test";

// Acceptance of a DEPLOYED environment (docs/ops/local-rehearsal.md): no dev stand is started, the specs talk to the
// public ingress like a user. Defaults point at the local rehearsal (tools/deploy/local.mjs); the local CA is not in
// the browser's store, hence ignoreHTTPSErrors.
export default defineConfig({
  testDir: "specs/rehearsal",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/rehearsal" }]],
  use: {
    baseURL: process.env.WIZARD_E2E_WEB ?? "https://wizard.localhost",
    ignoreHTTPSErrors: true,
    locale: "ru-RU",
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [{ name: "rehearsal", use: { ...devices["Desktop Chrome"] } }],
});
