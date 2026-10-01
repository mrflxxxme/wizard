// M2-09: the Prometheus registry behind /metrics of platform-api, worker and runtime — text format, label values
// restricted to tokens (no free text or personal data in labels), collectors, the dedicated listener.
import { describe, expect, test } from "vitest";
import { metricsListenFromEnv, Registry, safeLabelValue, serveMetrics } from "../src/metrics.js";

describe("metrics registry", () => {
  test("counter, gauge and histogram in the text exposition format", async () => {
    const r = new Registry();
    const c = r.counter("wizard_runs_finished_total", "Runs", ["kind", "status"]);
    c.inc({ kind: "build", status: "failed" });
    c.inc({ kind: "build", status: "failed" }, 2);
    const g = r.gauge("wizard_queue", "Queue", ["kind"]);
    g.set({ kind: "publish" }, 4);
    const h = r.histogram("wizard_run_duration_seconds", "Duration", ["kind"], [1, 10]);
    h.observe({ kind: "build" }, 0.5);
    h.observe({ kind: "build" }, 7);
    h.observe({ kind: "build" }, 30);
    const text = await r.render();
    expect(text).toContain("# TYPE wizard_runs_finished_total counter");
    expect(text).toContain('wizard_runs_finished_total{kind="build",status="failed"} 3');
    expect(text).toContain('wizard_queue{kind="publish"} 4');
    expect(text).toContain('wizard_run_duration_seconds_bucket{kind="build",le="1"} 1');
    expect(text).toContain('wizard_run_duration_seconds_bucket{kind="build",le="10"} 2');
    expect(text).toContain('wizard_run_duration_seconds_bucket{kind="build",le="+Inf"} 3');
    expect(text).toContain('wizard_run_duration_seconds_sum{kind="build"} 37.5');
    expect(text).toContain('wizard_run_duration_seconds_count{kind="build"} 3');
    expect(text.endsWith("\n")).toBe(true);
  });

  test("label values outside the token pattern become «other»; unknown labels and decreasing counters throw", () => {
    expect(safeLabelValue("G2-AF-08")).toBe("G2-AF-08");
    expect(safeLabelValue("ivan@example.com")).toBe("other");
    expect(safeLabelValue("Иван Петров")).toBe("other");
    expect(safeLabelValue('x"} 1\nevil 2')).toBe("other");
    const r = new Registry();
    const c = r.counter("wizard_x_total", "x", ["code"]);
    c.inc({ code: "+7 916 123-45-67" });
    expect(c.get({ code: "other" })).toBe(1);
    expect(() => c.inc({ phone: "1" })).toThrow(/unknown label/);
    expect(() => c.inc({}, -1)).toThrow();
    // Registering the same name twice returns the same metric; another type is an error.
    expect(r.counter("wizard_x_total", "x", ["code"])).toBe(c);
    expect(() => r.gauge("wizard_x_total", "x")).toThrow();
  });

  test("collectors run before rendering; a failing one is counted, the rest still renders", async () => {
    const r = new Registry();
    const g = r.gauge("wizard_depth", "Depth");
    let n = 0;
    r.collect(() => g.set(undefined, ++n));
    const off = r.collect(() => {
      throw new Error("db down");
    });
    expect(await r.render()).toContain("wizard_depth 1");
    const text = await r.render();
    expect(text).toContain("wizard_depth 2");
    expect(text).toContain("wizard_metrics_collect_errors_total 2");
    off();
    expect(await r.render()).toContain("wizard_metrics_collect_errors_total 2");
  });

  test("serveMetrics answers /metrics and /healthz only; env parsing", async () => {
    const r = new Registry();
    r.counter("wizard_y_total", "y").inc();
    const s = await serveMetrics({ registry: r, port: 0 });
    try {
      const m = await fetch(`http://127.0.0.1:${s.port}/metrics`);
      expect(m.status).toBe(200);
      expect(m.headers.get("content-type")).toContain("text/plain; version=0.0.4");
      expect(await m.text()).toContain("wizard_y_total 1");
      expect((await fetch(`http://127.0.0.1:${s.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${s.port}/api/v1/me`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${s.port}/metrics`, { method: "POST" })).status).toBe(405);
    } finally {
      await s.close();
    }
    expect(metricsListenFromEnv({})).toBeNull();
    expect(metricsListenFromEnv({ WIZARD_METRICS_PORT: "off" })).toBeNull();
    expect(metricsListenFromEnv({ WIZARD_METRICS_PORT: "9464", WIZARD_METRICS_HOST: "0.0.0.0" })).toEqual({
      port: 9464,
      hostname: "0.0.0.0",
    });
    expect(metricsListenFromEnv({ WIZARD_METRICS_PORT: "9464" })?.hostname).toBe("127.0.0.1");
    expect(() => metricsListenFromEnv({ WIZARD_METRICS_PORT: "x" })).toThrow();
  });
});
