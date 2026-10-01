// Sizing sampler of the pilot VM (tools/deploy/rss-sample.mjs, docs/ops/deploy.md «Пилот: замер»).
import { describe, expect, it } from "vitest";
import { classify, cpuTicks, createAccumulator, rssKib } from "../rss-sample.mjs";

describe("rss-sample.mjs", () => {
  it("classifies service processes by working directory; launch wrappers and browsers are skipped", () => {
    const tsx = "node --require /r/tsx/dist/preflight.cjs --import file:///r/tsx/dist/loader.mjs src/main.ts";
    expect(classify(tsx, "/w/apps/platform-api")).toBe("platform-api");
    expect(classify(tsx, "/w/apps/worker")).toBe("worker");
    expect(classify(tsx, "/w/apps/runtime")).toBe("runtime");
    expect(classify("node --import tsx src/egress-main.ts", "/w/apps/runtime")).toBe("egress-proxy");
    expect(classify("node /r/pnpm/bin/pnpm.cjs run dev", "/w/apps/worker")).toBeNull();
    expect(classify("node /r/tsx/dist/cli.mjs src/main.ts", "/w/apps/worker")).toBeNull();
    expect(classify("postgres: wizard wizard 127.0.0.1(5000) idle", "/")).toBe("postgres");
    expect(classify("/x/workerd serve /tmp/c.capnp", "/")).toBe("workerd");
    expect(classify("/opt/pw-browsers/chromium/chrome --type=renderer", "/w/apps/runtime")).toBeNull();
  });

  it("reads RSS and CPU ticks from /proc formats", () => {
    expect(rssKib("Name:\tnode\nVmRSS:\t  123456 kB\n")).toBe(123456);
    expect(rssKib("Name:\tkthreadd\n")).toBe(0);
    // comm may contain spaces and parentheses; utime/stime are fields 14 and 15.
    const stat = "42 (node (main)) S 1 2 3 4 5 6 7 8 9 10 300 200 0 0 20 0 1 0";
    expect(cpuTicks(stat)).toBe(500);
  });

  it("per phase and class: peak and mean RSS, CPU seconds and peak cores", () => {
    const acc = createAccumulator(100);
    acc.add("idle", [{ pid: "1", cls: "worker", rss: 100 * 1024, ticks: 0 }], 0);
    acc.add("idle", [{ pid: "1", cls: "worker", rss: 300 * 1024, ticks: 50 }], 1000);
    acc.add("build", [{ pid: "1", cls: "worker", rss: 500 * 1024, ticks: 250 }], 2000);
    expect(acc.report()).toEqual({
      idle: { worker: { peakMiB: 300, meanMiB: 200, cpuSec: 0.5, peakCores: 0.5 } },
      build: { worker: { peakMiB: 500, meanMiB: 500, cpuSec: 2, peakCores: 2 } },
    });
  });
});
