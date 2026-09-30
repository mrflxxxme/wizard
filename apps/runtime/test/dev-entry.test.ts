// M0-24: `pnpm --filter @wizard/runtime dev` listens on $PORT at $HOST (scripts/dev.mjs, docs/reviews/impl-notes/M0-27.md).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

test("dev entry serves /_wizard/health on PORT/HOST", async () => {
  const port = await freePort();
  const dir = join(import.meta.dirname, "..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WIZARD_DEV_LOGIN: "", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let status = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && status !== 200) {
      status = await fetch(`http://127.0.0.1:${port}/_wizard/health`)
        .then((r) => r.status)
        .catch(() => 0);
      if (status !== 200) await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe(200);
  } finally {
    child.kill("SIGTERM");
  }
}, 30_000);
