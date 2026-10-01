// A worker process for the kill -9 and canary tests (tsx): scripted executors and a slow router writing llm_calls.
// WZ_ENTRY_MODE=kill (default) builds normally; canary fails interview turns with PII inside the error; import runs
// the import fixtures of platform-api.
import { createRouter } from "@wizard/llm";
import { type InterviewHost, migrateDraft, type RunExecutors } from "@wizard/platform-api";
import postgres from "postgres";
import { fakeInterview, passingReport } from "../../../platform-api/test/helpers.js";
import { ENV, importBuild, mockProviders } from "../../../platform-api/test/import-fixtures.js";
import { startWorker } from "../../src/index.js";
import { recordingRouter, scriptedExecutors } from "../support.js";

const env = process.env;
const mode = env.WZ_ENTRY_MODE ?? "kill";
const dbUrl = env.WIZARD_DB_URL as string;
const pg = postgres(dbUrl, { max: 1, onnotice: () => {} });

async function canaryTurn(host: InterviewHost): Promise<never> {
  const prompt = [...host.context.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  await host.route({
    callType: "interview",
    messages: [{ role: "user", content: prompt }],
    step: "orchestrate",
  });
  // A PG error whose detail carries the user's e-mail: the log must keep only sqlstate/constraint.
  const email = /\S+@\S+/.exec(prompt)?.[0] ?? "x@example.com";
  await pg`insert into platform.users (email) values (${email}) on conflict do nothing`;
  await pg`insert into platform.users (email) values (${email})`;
  throw new Error(`unreachable ${prompt}`);
}

// WZ_ENTRY_MODE=import: the import fixtures of platform-api (client spec, mock T1 mapper, scripted builder).
const importExecutors: RunExecutors = {
  interviewTurn: fakeInterview,
  build: (host, p) => importBuild(host, p, []),
  gates: async (level, ctx) => passingReport(level, ctx.specVersion),
  onG0Passed: async (a) => {
    await migrateDraft(pg, { systemKey: a.systemKey, spec: a.spec, prevSpec: a.prevSpec });
    return { bundleKey: `${a.systemKey}/${a.revision}` };
  },
};
const mock = mockProviders();
const executors = scriptedExecutors();
const worker = await startWorker({
  config: {
    dbUrl,
    artifactsDir: env.WZ_ARTIFACTS as string,
    stepsDir: env.WZ_STEPS as string,
    secretsFile: env.WZ_SECRETS as string,
    authMode: "dev",
    runConcurrency: 2,
  },
  executors:
    mode === "import"
      ? importExecutors
      : mode === "canary"
        ? { ...executors, interviewTurn: canaryTurn }
        : executors,
  createRouter:
    mode === "import"
      ? (opts) => createRouter({ ...opts, mode: "live", env: ENV, fetch: mock.fetch, sleep: async () => {} })
      : recordingRouter({
          delayMs: Number(env.WZ_DELAY_MS ?? 250),
          mode: env.WZ_ROUTER_MODE === "fixture" ? "fixture" : "live",
          trace: (step) => process.stdout.write(`${JSON.stringify({ msg: "route", step })}\n`),
        }),
  sweepMs: 500,
  pollMs: 100,
});

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void worker
      .close()
      .finally(() => pg.end())
      .finally(() => process.exit(0));
  });
