// Local Postgres 16 without Docker: data dir .data/pg, port 5433, trust auth for local dev only.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = join(root, ".data", "pg");
const port = process.env.WIZARD_PG_PORT ?? "5433";

function pgBin(name) {
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    const versions = readdirSync(base).sort().reverse();
    for (const v of versions) {
      const p = join(base, v, "bin", name);
      if (existsSync(p)) return p;
    }
  }
  return name;
}

// Postgres refuses to run as root; in root containers run as the "postgres" system user.
const asRoot = process.getuid?.() === 0;

function run(bin, args) {
  const r = asRoot
    ? spawnSync("runuser", ["-u", "postgres", "--", pgBin(bin), ...args], { stdio: "inherit" })
    : spawnSync(pgBin(bin), args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cmd = process.argv[2];
if (cmd === "up") {
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    mkdirSync(dataDir, { recursive: true });
    if (asRoot) execFileSync("chown", ["-R", "postgres:postgres", join(root, ".data")]);
    run("initdb", ["-D", dataDir, "-U", "wizard", "--auth=trust", "-E", "UTF8", "--locale=C.UTF-8"]);
  }
  const status = asRoot
    ? spawnSync("runuser", ["-u", "postgres", "--", pgBin("pg_ctl"), "-D", dataDir, "status"], {
        stdio: "ignore",
      })
    : spawnSync(pgBin("pg_ctl"), ["-D", dataDir, "status"], { stdio: "ignore" });
  if (status.status !== 0)
    run("pg_ctl", [
      "-D",
      dataDir,
      "-o",
      `-p ${port} -k /tmp -c listen_addresses=localhost`,
      "-l",
      join(dataDir, "server.log"),
      "-w",
      "start",
    ]);
  ensureDb();
  console.log(`Postgres is up: postgres://wizard@localhost:${port}/wizard`);
} else if (cmd === "roles") {
  // For a Postgres that is already running (CI service, shared local server): database and roles only.
  ensureDb();
} else if (cmd === "down") {
  run("pg_ctl", ["-D", dataDir, "-m", "fast", "stop"]);
} else {
  console.error("usage: node scripts/db.mjs up|roles|down");
  process.exit(2);
}

function ensureDb() {
  try {
    execFileSync(pgBin("createdb"), ["-h", "localhost", "-p", port, "-U", "wizard", "wizard"], {
      stdio: "ignore",
    });
  } catch {
    // already exists
  }
  // Roles per runtime.yaml#postgres.roles: owner runs migrations only, runtime has no BYPASSRLS.
  const roles = `DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wizard_owner') THEN
      CREATE ROLE wizard_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wizard_runtime') THEN
      CREATE ROLE wizard_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;
  GRANT CREATE ON DATABASE wizard TO wizard_owner;`;
  execFileSync(
    pgBin("psql"),
    ["-h", "localhost", "-p", port, "-U", "wizard", "-d", "wizard", "-v", "ON_ERROR_STOP=1", "-c", roles],
    {
      stdio: "ignore",
    },
  );
}
