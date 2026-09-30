// `pnpm dev` of platform-api (scripts/dev.mjs contract, impl-notes M0-27): listens on $HOST:$PORT, loopback only.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, ROOT, waitFor } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
const children: ChildProcess[] = [];

beforeAll(async () => {
  tdb = await createTestDb("dev");
});
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const exited = (c: ChildProcess) => (alive(c) ? new Promise((r) => c.once("exit", r)) : Promise.resolve());
const stop = (c: ChildProcess) => {
  try {
    process.kill(-(c.pid as number), "SIGTERM"); // whole group: pnpm → tsx → node
  } catch {}
  return exited(c);
};

afterAll(async () => {
  await Promise.all(children.map(stop));
  await tdb?.drop();
});

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

function dev(env: Record<string, string>): ChildProcess {
  const c = spawn("pnpm", ["run", "--silent", "dev"], {
    cwd: join(ROOT, "apps/platform-api"),
    env: { ...process.env, WIZARD_DB_URL: tdb.url, WIZARD_AUTH_MODE: "dev", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(c);
  return c;
}

describe("dev script", () => {
  test("GET /api/v1/systems → 200 on $HOST:$PORT", async () => {
    const port = await freePort();
    const c = dev({ PORT: String(port), HOST: "127.0.0.1" });
    let log = "";
    c.stdout?.on("data", (d) => (log += d));
    c.stderr?.on("data", (d) => (log += d));
    const status = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/v1/systems`)).status;
      } catch {
        return undefined;
      }
    }, 25_000).catch((e) => {
      throw new Error(`${e}\n${log}`);
    });
    expect(status).toBe(200);
    const forwarded = await fetch(`http://127.0.0.1:${port}/api/v1/systems`, {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(forwarded.status).toBe(403);
    await stop(c);
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/v1/systems`);
        return false;
      } catch {
        return true;
      }
    });
  }, 40_000);

  test("refuses a non-loopback bind in dev mode", async () => {
    const c = dev({ PORT: String(await freePort()), HOST: "0.0.0.0" });
    let err = "";
    c.stderr?.on("data", (d) => (err += d));
    await exited(c);
    expect(c.exitCode).not.toBe(0);
    expect(err).toContain("127.0.0.1");
  }, 40_000);
});
