// Playwright stands (M1-08, M1-11; M2-11): platform-api in session mode (email OTP + dev-login for the specs),
// a real runtime serving draft and prod hosts over platform.deployments, platform-web on Vite, each on its own scratch
// database (CREATE DATABASE wz_e2e_<kind>_<hex> next to WIZARD_DB_URL — never the shared dev database). The builder
// and the interview are scripted (forum.json as ops + specs/runtime/examples, a change adds «Тема трека» to speaker
// applications): no LLM, real gates G0, bundles, prod migrations and publish/rollback runs. Table import (M1-12)
// routes import_mapping to logged mock providers (MOCK_PROVIDERS below).
// The M2 stand (stand/m2.ts) runs with WIZARD_MILESTONE=M2 rules (card binding before prod, G2 at publish) and the
// platform's YooKassa shop on YookassaMock with a test checkout page (stand/shop.ts). The pilot stand (stand/pilot.ts,
// M2-15) has the same M2 rules with WIZARD_REGISTRATION=invite and WIZARD_PAYMENTS=off and no shop.
// Run: `pnpm --filter @wizard/e2e exec tsx stand/m1.ts` or `stand/m2.ts` (Playwright starts them as webServers).
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { createRouter } from "@wizard/llm";
import { createAgentExecutors, createPlatformApi, RunFailure } from "@wizard/platform-api";
import { DbRegistry, startRuntime } from "@wizard/runtime";
import postgres from "postgres";
import { createServer } from "vite";
import { platformViteConfig } from "../../../apps/platform-web/vite.config.js";
import {
  M1,
  M1_DB_FILE,
  M1_LLM_LOG,
  M1_OUTBOX,
  M2,
  M2_DB_FILE,
  M2_LLM_LOG,
  M2_OUTBOX,
  PILOT,
  PILOT_DB_FILE,
  PILOT_LLM_LOG,
  PILOT_OUTBOX,
} from "./ports.js";
import { startShop } from "./shop.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HOST = "127.0.0.1";
const BASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

const CREATE_CARD = {
  title: "Форум «Северный ритейл»",
  summary: "Регистрация участников, билеты с QR, заявки спикеров и модерация",
  roles: [
    { name: "organizer", label: "Организатор", description: "ведёт программу и билеты" },
    { name: "participant", label: "Участник", description: "покупает билет" },
    { name: "speaker", label: "Спикер", description: "подаёт заявку на доклад" },
  ],
  specVsCode: {
    spec: ["Данные: билеты, потоки, заявки спикеров", "Права ролей проверяются на сервере"],
    code: ["Экраны: главная, каталог билетов, кабинет спикера"],
  },
  acceptance: [
    { id: "AC-1", text: "Участник покупает билет и получает QR" },
    { id: "AC-2", text: "Волонтёр проверяет QR на входе" },
    { id: "AC-3", text: "Спикер подаёт заявку" },
    { id: "AC-4", text: "Модератор принимает или отклоняет заявку" },
    { id: "AC-5", text: "Участник видит только свои билеты" },
    { id: "AC-6", text: "Организатор видит отчёт по продажам" },
  ],
  estimate: { credits: { min: 10, expected: 20, max: 30 }, minutes: { min: 5, max: 10 } },
  cap: { credits: 40 },
};

let changes = 0;
function changeCard() {
  return {
    title: "Правка форума",
    summary: "Добавить поле «Тема трека» в заявки спикеров",
    estimate: { credits: { min: 1, expected: 2, max: 4 }, minutes: { min: 1, max: 3 } },
    cap: { credits: 4 },
  };
}

/** Forum code of specs/runtime/examples (bakery excluded) as the builder would write it. */
function forumFiles(): Map<string, string> {
  const base = join(ROOT, "specs/runtime/examples");
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(base, abs);
      if (rel === "bakery") continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(base);
  return out;
}

type Executors = ReturnType<typeof createAgentExecutors>;
type BuildHost = Parameters<Executors["build"]>[0];
type BuildParams = Parameters<Executors["build"]>[1];

async function scriptedBuild(host: BuildHost, p: BuildParams) {
  const { version } = await host.store.getSpec();
  let batches: unknown[][];
  if (p.mode === "create") {
    const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as {
      specToOps(spec: unknown, o: { author: string }): unknown[];
      batchOps(ops: unknown[]): unknown[][];
    };
    const spec = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8"));
    batches = lib.batchOps(lib.specToOps(spec, { author: "agent" }));
  } else {
    changes++;
    const n = changes === 1 ? "" : ` ${changes}`;
    batches = [
      [
        {
          op: "add_field",
          entity: "speaker_application",
          field: { name: `track_theme${n ? `_${changes}` : ""}`, label: `Тема трека${n}`, type: "string" },
        },
      ],
    ];
  }
  let v = version;
  for (const [i, batch] of batches.entries()) {
    const r = await host.store.applyOps(batch as never, v, `${host.run.id}:ops_${i}:1`);
    if (!r.ok) throw new RunFailure("GATES_FAILED", JSON.stringify(r.errors));
    v = r.version;
  }
  if (p.mode === "create") for (const [path, src] of forumFiles()) await host.store.writeFile(path, src);
  await host.store.commitFiles();
  const report = await host.runGates("G0");
  if (!report.passed)
    throw new RunFailure(
      "GATES_FAILED",
      JSON.stringify(report.checks.filter((c) => c.status === "fail" || c.status === "error")),
    );
  return { summary_ru: p.mode === "create" ? "Собрал форум" : "Добавил поле «Тема трека»" };
}

// M1-12: the import_mapping call goes through the real router (DLP, tiers) to OpenAI-compatible mock providers that
// log every request (the spec checks no cell value reached them) and propose forum fields by column header.
const MOCK_PROVIDERS = {
  ZAI_BASE_URL: "http://mock.local/zai",
  ZAI_API_KEY: "k",
  CLOUDRU_BASE_URL: "http://mock.local/cloudru",
  CLOUDRU_API_KEY: "k",
};
/** Proposal of the mock mapper; «Описание» stays skipped so the spec edits it on S-import. */
const IMPORT_TARGETS: Record<string, [string, string]> = {
  "Название потока": ["stream", "name"],
  Вместимость: ["stream", "capacity"],
};

/** JSON lines of the mock providers of the running stand (set by startStand). */
let llmLog: string = M1_LLM_LOG;

const mockProviders = (async (url: string | URL | Request, init?: RequestInit) => {
  const provider = String(url).includes("/zai") ? "zai" : "cloudru";
  const body = String(init?.body ?? "");
  appendFileSync(llmLog, `${JSON.stringify({ provider, body })}\n`);
  const req = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
  let message: Record<string, unknown> = { role: "assistant", content: "Готово" };
  if (body.includes("propose_mapping")) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "{}";
    const { table } = JSON.parse(user) as {
      table: { sheets: { name: string; columns: { header: string }[] }[] };
    };
    const mappings = table.sheets.flatMap((sh) =>
      sh.columns.map((c) => {
        const t = IMPORT_TARGETS[c.header];
        return t
          ? { sheet: sh.name, column: c.header, action: "map", entity: t[0], field: t[1] }
          : { sheet: sh.name, column: c.header, action: "skip" };
      }),
    );
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "propose_mapping", arguments: JSON.stringify({ mappings }) },
        },
      ],
    };
  }
  return new Response(
    JSON.stringify({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: req.model,
      choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof globalThis.fetch;

export type StandKind = "m1" | "m2" | "pilot";

const STANDS = {
  m1: { ports: { ...M1, shop: 0 }, files: { dbFile: M1_DB_FILE, outbox: M1_OUTBOX, llmLog: M1_LLM_LOG } },
  m2: { ports: M2, files: { dbFile: M2_DB_FILE, outbox: M2_OUTBOX, llmLog: M2_LLM_LOG } },
  pilot: {
    ports: { ...PILOT, shop: 0 },
    files: { dbFile: PILOT_DB_FILE, outbox: PILOT_OUTBOX, llmLog: PILOT_LLM_LOG },
  },
} as const;

/** Starts the stand of `kind` and stops it (dropping its database) on SIGINT/SIGTERM. */
export async function startStand(kind: StandKind): Promise<void> {
  const { ports, files } = STANDS[kind];
  llmLog = files.llmLog;
  const DB = `wz_e2e_${kind}_${randomBytes(4).toString("hex")}`;
  const log = (m: string) => console.log(`[${kind}-stand] ${m}`);
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  // Databases of stands killed without cleanup: nobody is connected to them any more.
  for (const { datname } of await admin<{ datname: string }[]>`
    select d.datname from pg_catalog.pg_database d
    where d.datname like ${`wz\\_e2e\\_${kind}\\_%`}
      and not exists (select 1 from pg_catalog.pg_stat_activity a where a.datname = d.datname)`)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${JSON.stringify(datname)}`).catch(() => {});
  const live = new Set(
    (await admin<{ datname: string }[]>`select datname from pg_catalog.pg_database`).map((r) => r.datname),
  );
  const standDir = join(ROOT, ".data", `e2e-${kind}`);
  mkdirSync(standDir, { recursive: true });
  for (const name of readdirSync(standDir))
    if (name.startsWith("artifacts-") && !live.has(name.slice("artifacts-".length)))
      rmSync(join(standDir, name), { recursive: true, force: true });
  await admin.unsafe(`CREATE DATABASE ${DB}`);
  for (const role of ["wizard_owner", "wizard_runtime"])
    await admin.unsafe(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
  await admin.unsafe(`GRANT CREATE ON DATABASE ${DB} TO wizard_owner`);
  const url = new URL(BASE_URL);
  url.pathname = `/${DB}`;
  const pg = postgres(url.toString(), { max: 4, onnotice: () => {} });
  const artifacts = join(standDir, `artifacts-${DB}`);
  mkdirSync(artifacts, { recursive: true });
  rmSync(files.outbox, { recursive: true, force: true });
  rmSync(files.llmLog, { force: true });
  writeFileSync(files.dbFile, url.toString(), { mode: 0o600 });
  // M2: the platform's own YooKassa shop (billing.yaml#recurring) on the mock, with its test checkout page.
  const shop =
    kind === "m2" ? await startShop({ port: ports.shop, webhook: `http://${HOST}:${ports.api}` }) : null;

  const platform = await createPlatformApi({
    config: {
      dbUrl: url.toString(),
      artifactsDir: artifacts,
      authMode: "session",
      devLogin: true,
      outboxDir: files.outbox,
      runtimePort: ports.runtime,
      platformOrigin: `http://localhost:${ports.web}`,
      // T1 build by default (models.yaml#week0_decision): «только РФ» visibly changes the S1 policy label.
      buildDefaultTier: "T1",
      ...(kind !== "m1"
        ? {
            // WIZARD_MILESTONE=M2: card binding before prod and G1 + G2 at publish (config.ts m2OrProd). The publish
            // G1 runs the forum's functions in the platform's in-process runtime: unsafe-local exec, as the stand's
            // own runtime (docs/reviews/impl-notes/M2-AC6-prod-g1.md).
            milestone: "M2",
            cardBindingRequired: true,
            prodG2Required: true,
            unsafeLocalExec: true,
          }
        : {}),
      ...(shop
        ? {
            platformShop: { shopId: shop.mock.shopId, secretKey: shop.mock.secretKey },
            yookassaApiBase: shop.apiBase,
            // Notifications come from the checkout page of this stand only.
            yookassaIpAllowlist: ["127.0.0.1/32"],
          }
        : {}),
      // Pilot (M2-15, deploy.yaml#pilot.env): invite-only registration, payments off.
      ...(kind === "pilot" ? { registration: "invite", payments: false } : {}),
    },
    executors: (d) => ({
      ...createAgentExecutors(d),
      interviewTurn: async (host) =>
        host.context.system.previewRevision === null
          ? { kind: "card" as const, text: "Карточка системы готова", card: CREATE_CARD }
          : { kind: "card" as const, text: "Предлагаю правку", card: changeCard() },
      build: scriptedBuild,
    }),
    createRouter: (opts) =>
      createRouter({
        ...opts,
        mode: "live",
        env: MOCK_PROVIDERS,
        fetch: mockProviders,
        sleep: async () => {},
      }),
    log: (m, e) => console.error(`[${kind}-stand] platform-api: ${m}`, e ?? ""),
  });
  const apiServer = serve({ fetch: platform.fetch, port: ports.api, hostname: HOST });
  const runtime = await startRuntime({
    db: pg,
    registry: new DbRegistry(pg),
    artifactsRoot: artifacts,
    port: ports.runtime,
    env: {
      systemsDomain: "localhost",
      devLogin: true,
      unsafeLocalExec: true,
      platformOrigin: `http://localhost:${ports.web}`,
    },
  });
  const vite = await createServer({
    configFile: false,
    ...platformViteConfig({
      apiTarget: `http://${HOST}:${ports.api}`,
      frameSrc: [`http://*.localhost:${ports.runtime}`],
      port: ports.web,
      host: HOST,
    }),
  });
  await vite.listen();
  log(
    `готов: http://localhost:${ports.web} (api :${ports.api}, runtime :${ports.runtime}${shop ? `, магазин ${shop.origin}` : ""}, БД ${DB})`,
  );

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    log("остановка…");
    await vite.close().catch(() => {});
    await new Promise<void>((r) => apiServer.close(() => r()));
    await runtime.close().catch(() => {});
    await platform.close().catch(() => {});
    await shop?.close().catch(() => {});
    await pg.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(files.dbFile, { force: true });
    process.exit(0);
  }
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
