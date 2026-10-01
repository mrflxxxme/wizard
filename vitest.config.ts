import { configDefaults, defineConfig } from "vitest/config";

// Chromium suites (*.browser.test.ts) each start a browser with several processes; they run one file at a time in
// their own project while the rest of the suite stays parallel, so a 2–4 core CI is not oversubscribed (FU-3).
const browser = ["packages/*/test/**/*.browser.test.ts", "apps/*/test/**/*.browser.test.ts"];

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Hooks start runtimes, roles and browsers against a shared Postgres; 10 s (the default) is too tight on a
    // loaded CI. Hooks that legitimately take longer still set their own timeout.
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "tools/*/test/**/*.test.ts",
            "tools/*/test/**/*.test.mjs",
            "infra/*/test/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, ...browser],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: browser,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
