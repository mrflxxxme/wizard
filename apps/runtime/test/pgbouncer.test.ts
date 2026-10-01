// L3-21 (platform/deploy.yaml#cloud.postgres.pooling, security/isolation.yaml#db_access): through PgBouncer in
// transaction mode, two transactions of different systems served by ONE server connection never see each other's
// GUC context (set_config(..., true)) or role. A session-level SET is the negative control: it does leak, so the test
// would notice a regression to SET without LOCAL.
//
// Needs a PgBouncer ≥ 1.21 binary: WIZARD_PGBOUNCER_BIN (spawned here as a plain user process with default_pool_size=1,
// so every client shares one server connection) or WIZARD_PGBOUNCER_URL (an already running one in transaction mode
// with a pool of 1). Without either the suite is skipped (CI job `pgbouncer` in .github/workflows/ci.yml sets it).
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemRoleOf } from "../src/index.js";
import { DB_URL, forumSpec, type Harness, harness, login, request, seedRow } from "./helpers.js";

const BIN = process.env.WIZARD_PGBOUNCER_BIN;
const GIVEN_URL = process.env.WIZARD_PGBOUNCER_URL;
const enabled = Boolean(BIN || GIVEN_URL);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function startBouncer(): Promise<{ url: string; stop(): void }> {
  if (GIVEN_URL) return { url: GIVEN_URL, stop() {} };
  const db = new URL(DB_URL);
  const dir = mkdtempSync(join(tmpdir(), "wz-pgb-"));
  const port = await freePort();
  const user = decodeURIComponent(db.username || "wizard");
  const dbname = db.pathname.slice(1) || "wizard";
  writeFileSync(join(dir, "users.txt"), `"${user}" ""\n`);
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    [
      "[databases]",
      `${dbname} = host=${db.hostname === "localhost" ? "127.0.0.1" : db.hostname} port=${db.port || 5432} dbname=${dbname} user=${user}${db.password ? ` password=${decodeURIComponent(db.password)}` : ""}`,
      "[pgbouncer]",
      "listen_addr = 127.0.0.1",
      `listen_port = ${port}`,
      "unix_socket_dir =",
      "auth_type = trust",
      `auth_file = ${join(dir, "users.txt")}`,
      "pool_mode = transaction",
      "default_pool_size = 1",
      "min_pool_size = 0",
      "max_client_conn = 50",
      "max_prepared_statements = 100",
      "ignore_startup_parameters = extra_float_digits,options",
      "",
    ].join("\n"),
  );
  // PgBouncer refuses to run as root (CI containers, sandboxes): it then drops to `nobody`, which must read the files.
  const asRoot = process.getuid?.() === 0;
  if (asRoot) {
    chmodSync(dir, 0o755);
    for (const f of ["users.txt", "pgbouncer.ini"]) chmodSync(join(dir, f), 0o644);
  }
  const args = [...(asRoot ? ["-u", "nobody"] : []), join(dir, "pgbouncer.ini")];
  const child: ChildProcess = spawn(BIN as string, args, { stdio: "ignore" });
  const url = `postgres://${encodeURIComponent(user)}${db.password ? `:${db.password}` : ""}@127.0.0.1:${port}/${dbname}`;
  for (let i = 0; i < 50; i++) {
    const probe = postgres(url, { max: 1, connect_timeout: 1, onnotice: () => {} });
    const ok = await probe`select 1`.then(
      () => true,
      () => false,
    );
    await probe.end({ timeout: 1 });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop() {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!enabled)("PgBouncer transaction mode (L3-21)", () => {
  let bouncer: { url: string; stop(): void };
  let a: postgres.Sql;
  let b: postgres.Sql;
  let h: Harness;
  let bouncerSql: postgres.Sql;
  type System = { key: string; schema: string };
  const sys: System[] = [];

  beforeAll(async () => {
    bouncer = await startBouncer();
    // Two client connections of the pool: one per "system".
    a = postgres(bouncer.url, { max: 1, onnotice: () => {} });
    b = postgres(bouncer.url, { max: 1, onnotice: () => {} });
    bouncerSql = postgres(bouncer.url, { max: 4, onnotice: () => {} });
    h = await harness({}, { db: bouncerSql, files: null });
    sys.push(await h.system("pgba", forumSpec(), "draft"));
    sys.push(await h.system("pgbb", forumSpec(), "draft"));
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await Promise.all([a?.end(), b?.end(), bouncerSql?.end()]);
    bouncer?.stop();
  });

  it("both clients really share one server connection", async () => {
    const [pa] = await a`select pg_backend_pid() as pid`;
    const [pb] = await b`select pg_backend_pid() as pid`;
    expect(pa?.pid).toBe(pb?.pid);
  });

  it("set_config(..., true) of system A is invisible to the next transaction of system B", async () => {
    const [sa, sb] = sys as [System, System];
    const roleA = systemRoleOf(sa.key, "draft");
    const roleB = systemRoleOf(sb.key, "draft");
    const login = (await a`select current_user as u`)[0]?.u as string;
    for (let i = 0; i < 5; i++) {
      const seenByA = await a.begin(async (tx) => {
        await tx`select set_config('role', ${roleA}, true), set_config('wizard.user_id', ${`user-a-${i}`}, true),
                 set_config('wizard.role', 'organizer', true)`;
        const [r] = await tx`select current_user as u, current_setting('wizard.user_id', true) as uid`;
        return r;
      });
      expect(seenByA).toEqual({ u: roleA, uid: `user-a-${i}` });
      // Next transaction on the same server connection, from the other client (system B).
      const seenByB = await b.begin(async (tx) => {
        const [before] = await tx`select current_user as u, current_setting('wizard.user_id', true) as uid,
                                         current_setting('wizard.role', true) as role`;
        await tx`select set_config('role', ${roleB}, true), set_config('wizard.user_id', ${`user-b-${i}`}, true)`;
        return before;
      });
      expect(seenByB?.u).toBe(login);
      expect(seenByB?.uid ?? "").toBe("");
      expect(seenByB?.role ?? "").toBe("");
      const [after] = await a`select current_user as u, current_setting('wizard.user_id', true) as uid`;
      expect(after?.u).toBe(login);
      expect(after?.uid ?? "").toBe("");
    }
  });

  it("negative control: a session-level SET leaks across clients (why SET without LOCAL is banned)", async () => {
    // wizard-allow-sql: the banned statement on purpose — it shows why the ban exists.
    await a.unsafe("SET wizard.leak_probe = 'from-a'");
    try {
      const [r] = await b`select current_setting('wizard.leak_probe', true) as v`;
      expect(r?.v).toBe("from-a");
    } finally {
      await a.unsafe("RESET wizard.leak_probe");
    }
  });

  it("the runtime data API of two systems through one server connection: no context bleeds", async () => {
    const spec = forumSpec();
    const [sa, sb] = sys as [System, System];
    for (let i = 0; i < 3; i++) await seedRow(h.sql, sa.schema, spec, "stream");
    await seedRow(h.sql, sb.schema, spec, "stream");
    const ca = await login(h.rt, "pgba--draft.localhost:4100", "organizer");
    const cb = await login(h.rt, "pgbb--draft.localhost:4100", "organizer");
    const list = async (host: string, cookie: string) => {
      const res = await h.rt.fetch(request("GET", host, "/api/data/stream?limit=50", { cookie }));
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: unknown[] }).items.length;
    };
    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? list("pgba--draft.localhost:4100", ca) : list("pgbb--draft.localhost:4100", cb),
      ),
    );
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 3 : 1)));
    const dbUser = (await h.sql`select current_user as u`)[0]?.u as string;
    const [left] = await a`select current_user as u, current_setting('wizard.user_id', true) as uid`;
    expect(left?.u).toBe(dbUser);
    expect(left?.uid ?? "").toBe("");
  });
});
