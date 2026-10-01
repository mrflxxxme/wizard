// Dev orchestrator (M0-27): ports and hosts — specs/platform/deploy.yaml#local; plus the DBOS worker (M1-01).
// Starts each app via its own `dev` script (PORT/HOST in env); an app without one gets a stub HTTP server.
// Flags: --no-db, --stub (force stubs), --port-api=N, --port-web=N, --port-runtime=N, --root=DIR, --timeout=MS.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";

const HOST = "127.0.0.1";
const STUB_HEADER = "x-wizard-dev-stub";
const READY_LINE = "wizard dev: все сервисы готовы";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const root = resolve(args.get("root") ?? join(import.meta.dirname, ".."));
const timeoutMs = Number(args.get("timeout") ?? 90_000);

const services = [
  { id: "platform-api", dir: "apps/platform-api", port: 4000, probe: "/api/v1/systems" },
  { id: "runtime", dir: "apps/runtime", port: 4100, probe: "/_wizard/health" },
  { id: "platform-web", dir: "apps/platform-web", port: 5173, probe: "/" },
];
for (const s of services) {
  const key = `port-${s.id.replace("platform-", "")}`;
  if (args.has(key)) s.port = Number(args.get(key));
}

const log = (msg) => console.log(`[dev] ${msg}`);
const fail = (msg) => {
  console.error(`[dev] ошибка: ${msg}`);
  process.exit(1);
};

function portOpen(port) {
  return new Promise((res) => {
    const sock = connect({ host: HOST, port });
    sock.once("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.once("error", () => res(false));
  });
}

function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen(port, HOST, () => srv.close(() => res(true)));
  });
}

function probe(port, path) {
  return new Promise((res) => {
    const req = request({ host: HOST, port, path, method: "GET", timeout: 2_000 }, (r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    req.once("error", () => res(0));
    req.once("timeout", () => req.destroy());
    req.end();
  });
}

function devScript(dir) {
  const pkgPath = join(root, dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  return JSON.parse(readFileSync(pkgPath, "utf8")).scripts?.dev;
}

function startStub(s) {
  const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Wizard — ${s.id}</title></head><body><h1>Wizard</h1><p>Заглушка ${s.id}: у приложения ещё нет скрипта dev.</p></body></html>`;
  const srv = createServer((req, res) => {
    const html = s.id === "platform-web" && !req.url?.startsWith("/api/");
    res.writeHead(200, {
      [STUB_HEADER]: s.id,
      "content-type": html ? "text/html; charset=utf-8" : "application/json",
    });
    res.end(html ? page : JSON.stringify({ status: "ok", stub: true, app: s.id }));
  });
  return new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(s.port, HOST, () => res(srv));
  });
}

const children = [];
const stubs = [];
let stopping = false;

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log("остановка…");
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
  }
  await Promise.all(
    stubs.map(
      (srv) =>
        new Promise((r) => {
          srv.close(() => r());
          srv.closeAllConnections();
        }),
    ),
  );
  // Wait for whole process groups (pnpm -> tsx/vite), not just the direct children.
  const groupAlive = (c) => {
    try {
      process.kill(-c.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 5_000;
  while (children.some(groupAlive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// .env is optional; apps read the same variables (deploy.yaml#local.env_vars).
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
// Offline demo out of the box: fixture mode replays the golden «форум» run unless told otherwise.
if ((process.env.WIZARD_LLM_MODE ?? "fixture") === "fixture") process.env.WIZARD_FIXTURE ??= "demo/forum";
// platform-api defaults to session auth (email OTP, M1-02); the local stand keeps the M0 dev user unless told otherwise.
process.env.WIZARD_AUTH_MODE ??= "dev";
// M3-02: AI actions of local systems — the runtime calls the platform's AI gateway with a per-run internal token.
process.env.WIZARD_INTERNAL_TOKEN ||= randomBytes(16).toString("hex");
process.env.WIZARD_PLATFORM_INTERNAL_URL ||= `http://${HOST}:${services[0].port}`;

if (!args.has("no-db")) {
  const pgPort = Number(process.env.WIZARD_PG_PORT ?? 5433);
  if (await portOpen(pgPort)) {
    log(`Postgres уже слушает :${pgPort}`);
    // CI service or a shared server: the draft migrations still need wizard_owner/wizard_runtime.
    const r = spawnSync(process.execPath, [join(root, "scripts/db.mjs"), "roles"], { stdio: "inherit" });
    if (r.status !== 0)
      log("не удалось создать роли wizard_owner/wizard_runtime — сборка превью может упасть");
  } else {
    const r = spawnSync(process.execPath, [join(root, "scripts/db.mjs"), "up"], { stdio: "inherit" });
    if (r.status !== 0) fail("не удалось поднять Postgres (pnpm db:up)");
  }
}

for (const s of services) {
  if (!(await portFree(s.port)))
    fail(`порт ${s.port} (${s.id}) занят — остановите процесс, который его слушает`);
}

function startApp(s, env) {
  let out = "";
  const child = spawn("pnpm", ["run", "dev"], {
    cwd: join(root, s.dir),
    env: { ...process.env, ...env, HOST },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so shutdown reaches grandchildren (tsx, vite)
  });
  const prefix = (chunk) => {
    if (out.length < 65_536) out += chunk;
    return chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => `[${s.id}] ${l}\n`)
      .join("");
  };
  child.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[dev] ошибка: ${s.id} завершился (code=${code}, signal=${signal})`);
    shutdown(1);
  });
  children.push(child);
  return () => out;
}

for (const s of services) {
  const script = args.has("stub") ? undefined : devScript(s.dir);
  if (!script) {
    stubs.push(await startStub(s));
    log(`${s.id}: заглушка на http://localhost:${s.port}`);
    continue;
  }
  startApp(s, { PORT: String(s.port) });
  log(`${s.id}: pnpm run dev (PORT=${s.port})`);
}

// Background apps without a port (M1-01): the DBOS worker executes the runs platform-api enqueues
// (workflows.yaml#execution.M1). Started only when the app has a dev script; ready = its "ready" log line.
const background = [{ id: "worker", dir: "apps/worker", ready: '"msg":"ready"' }];
for (const b of background) {
  if (args.has("stub") || !devScript(b.dir)) continue;
  b.out = startApp(b, {});
  log(`${b.id}: pnpm run dev`);
}

const deadline = Date.now() + timeoutMs;
for (const s of services) {
  let status = 0;
  while (!stopping && Date.now() < deadline) {
    status = await probe(s.port, s.probe);
    if (status > 0 && status < 500) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (stopping) break;
  if (!(status > 0 && status < 500)) {
    console.error(
      `[dev] ошибка: ${s.id} не ответил на ${s.probe} за ${timeoutMs} мс (последний статус ${status})`,
    );
    await shutdown(1);
  }
  log(`${s.id}: готов (GET ${s.probe} → ${status})`);
}
for (const b of background) {
  if (!b.out || stopping) continue;
  while (!stopping && Date.now() < deadline && !b.out().includes(b.ready))
    await new Promise((r) => setTimeout(r, 250));
  if (stopping) break;
  if (!b.out().includes(b.ready)) {
    console.error(`[dev] ошибка: ${b.id} не сообщил о готовности за ${timeoutMs} мс`);
    await shutdown(1);
  }
  log(`${b.id}: готов`);
}
if (!stopping) log(`${READY_LINE}. Ctrl-C — остановить.`);
