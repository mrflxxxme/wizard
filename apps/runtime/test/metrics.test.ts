// M2-09: runtime /metrics on a dedicated listener (WIZARD_METRICS_PORT) — public port requests by status class and
// latency, no tenant data in labels; nothing on the public port.
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryRegistry, runtimeMetrics, startRuntime } from "../src/index.js";
import { devEnv } from "./helpers.js";

const sql = postgres("postgres://nobody@127.0.0.1:1/none", { max: 1, connect_timeout: 1 });

afterAll(async () => {
  await sql.end({ timeout: 0 });
});

describe("runtime metrics", () => {
  it("counts public requests by status class; /metrics only on the metrics port", async () => {
    const { close, metricsPort } = await startRuntime({
      db: sql,
      registry: new MemoryRegistry(),
      env: devEnv,
      port: 45_993,
      internalPort: null,
      metricsPort: 0,
      retentionTickMs: 0,
    });
    try {
      expect(metricsPort).toBeGreaterThan(0);
      const before = (await runtimeMetrics.render()).match(
        /wizard_runtime_http_requests_total\{class="2xx"\} (\d+)/,
      );
      expect((await fetch("http://127.0.0.1:45993/_wizard/health")).status).toBe(200);
      // A system host that does not exist: 4xx, and the host never becomes a label.
      await fetch("http://127.0.0.1:45993/", { headers: { host: "secret-shop--draft.localhost:4100" } });
      const text = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
      const after = text.match(/wizard_runtime_http_requests_total\{class="2xx"\} (\d+)/);
      expect(Number(after?.[1])).toBe(Number(before?.[1] ?? 0) + 1);
      expect(text).toMatch(/wizard_runtime_http_requests_total\{class="4xx"\} [1-9]/);
      expect(text).toMatch(/wizard_runtime_http_request_duration_seconds_count [1-9]/);
      expect(text).toContain("# TYPE wizard_runtime_retention_passes_total counter");
      expect(text).not.toContain("secret-shop");
      expect((await fetch("http://127.0.0.1:45993/metrics")).headers.get("content-type") ?? "").not.toContain(
        "version=0.0.4",
      );
    } finally {
      await close();
    }
  });
});
