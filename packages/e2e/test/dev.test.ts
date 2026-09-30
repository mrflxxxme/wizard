import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const DEV = join(import.meta.dirname, "..", "..", "..", "scripts", "dev.mjs");
const READY = "все сервисы готовы";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function freePorts(n: number): Promise<number[]> {
  const servers: Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    servers.push(srv);
    ports.push((srv.address() as { port: number }).port);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

type Run = { child: ChildProcess; out: () => string; exit: Promise<number | null> };

function runDev(extra: string[]): Run {
  const child = spawn(process.execPath, [DEV, "--no-db", "--timeout=20000", ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    out += d;
  });
  const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  cleanups.push(() => child.kill("SIGKILL"));
  return { child, out: () => out, exit };
}

async function waitFor(run: Run, text: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!run.out().includes(text)) {
    if (Date.now() > end || run.child.exitCode !== null) throw new Error(`no "${text}" in:\n${run.out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function portArgs([api, web, runtime]: number[]): string[] {
  return [`--port-api=${api}`, `--port-web=${web}`, `--port-runtime=${runtime}`];
}

function tempRoot(apps: Record<string, { dev: string; files?: Record<string, string> }>): string {
  const root = mkdtempSync(join(tmpdir(), "wizard-dev-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [dir, app] of Object.entries(apps)) {
    const p = join(root, "apps", dir);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "package.json"), JSON.stringify({ name: `t-${dir}`, scripts: { dev: app.dev } }));
    for (const [f, body] of Object.entries(app.files ?? {})) writeFileSync(join(p, f), body);
  }
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("scripts/dev.mjs", () => {
  test("без dev-скриптов поднимает заглушки, ждёт health; SIGINT гасит всё", async () => {
    const ports = await freePorts(3);
    const run = runDev([...portArgs(ports), "--stub"]);
    await waitFor(run, READY);
    for (const port of ports) {
      const res = await fetch(`http://127.0.0.1:${port}/_wizard/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-wizard-dev-stub")).toBeTruthy();
    }
    run.child.kill("SIGINT");
    expect(await run.exit).toBe(0);
    for (const port of ports) {
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    }
  });

  test("занятый порт — ошибка до запуска", async () => {
    const ports = await freePorts(3);
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(ports[1], "127.0.0.1", () => r()));
    cleanups.push(() => busy.close());
    const run = runDev([...portArgs(ports), "--stub"]);
    expect(await run.exit).toBe(1);
    expect(run.out()).toContain(`порт ${ports[1]}`);
  });

  test("запускает `dev` приложения с PORT и гасит его процесс по SIGINT", async () => {
    const ports = await freePorts(3);
    const server = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync("pid", String(process.pid));
createServer((q, s) => s.end("real")).listen(Number(process.env.PORT), process.env.HOST);`;
    const root = tempRoot({ "platform-api": { dev: "node server.mjs", files: { "server.mjs": server } } });
    const run = runDev([...portArgs(ports), `--root=${root}`]);
    await waitFor(run, READY);
    const res = await fetch(`http://127.0.0.1:${ports[0]}/`);
    expect(await res.text()).toBe("real");
    expect(res.headers.get("x-wizard-dev-stub")).toBeNull();
    const pid = Number(readFileSync(join(root, "apps", "platform-api", "pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    run.child.kill("SIGINT");
    expect(await run.exit).toBe(0);
    expect(alive(pid)).toBe(false);
  });

  test("падение приложения останавливает dev с кодом 1", async () => {
    const ports = await freePorts(3);
    const root = tempRoot({ runtime: { dev: 'node -e "process.exit(3)"' } });
    const run = runDev([...portArgs(ports), `--root=${root}`]);
    expect(await run.exit).toBe(1);
    expect(run.out()).toContain("runtime завершился");
  });
});
