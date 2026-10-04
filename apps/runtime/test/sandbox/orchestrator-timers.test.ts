// M2-18: lease() on the real clock and timers, as production runs it. A fake sleep that resolves at once can hide a
// loop that never yields: here the event loop must keep ticking and the heap must stay bounded while a call waits.
import { describe, expect, it } from "vitest";
import { FakeKube, makeRealTime, sys } from "./fake-kube.js";

const A = "aaaaaaaaaaaa";

/** A pod whose next start fails at once (CrashLoopBackOff), once. */
class FlakyKube extends FakeKube {
  failNext = false;
  override async getPod(name: string) {
    const p = await super.getPod(name);
    if (p && this.failNext) {
      this.failNext = false;
      return { ...p, ready: false, podIP: null, reason: "CrashLoopBackOff" };
    }
    return p;
  }
}

/** Runs `f` while counting 10 ms ticks of the event loop and the heap growth. */
async function watched<T>(f: () => Promise<T>) {
  let ticks = 0;
  const iv = setInterval(() => {
    ticks += 1;
  }, 10);
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  try {
    const out = await f();
    return { out, ticks, ms: Date.now() - t0, heapMB: (process.memoryUsage().heapUsed - heap0) / 1e6 };
  } finally {
    clearInterval(iv);
  }
}

describe("SandboxOrchestrator.lease on real timers", () => {
  it("a start this call made fails: the call gets that failure at once, even with another start queued", async () => {
    const kube = new FlakyKube();
    const o = makeRealTime(kube, { pollMs: 50, readyTimeoutMs: 1000, podStartMs: 500 });
    await o.prepare(sys(A));
    // The pod is lost and its re-create fails: no record, an idle queue.
    kube.pods.clear();
    kube.failNext = true;
    await o.check().catch(() => {});
    expect(o.endpointOf(A, "draft")).toBeNull();
    kube.failNext = true;
    kube.readyAfter = 1e9;
    const r = await watched(async () => {
      const lease = o.lease(A, "draft", 5000).then(
        () => "ok",
        (e: Error) => e.message,
      );
      // Queued behind the call's own start, never ready: the queue stays busy after that start failed.
      const queued = o.prepare(sys("bbbbbbbbbbbb")).catch(() => {});
      const out = await lease;
      await queued;
      return out;
    });
    // Before: a settled promise raced in a loop until the call's limit — no ticks, the heap grew by hundreds of MB.
    expect(r.out).toBe("Песочница функций не запустилась");
    expect(r.heapMB).toBeLessThan(64);
    expect(r.ticks).toBeGreaterThan(10);
  }, 30_000);

  it("waiting for another start, the call yields to the event loop until its own limit", async () => {
    const kube = new FakeKube();
    kube.readyAfter = 1e9;
    const o = makeRealTime(kube, { pollMs: 50, readyTimeoutMs: 1500, podStartMs: 500 });
    const starting = o.prepare(sys(A)).catch(() => {});
    const r = await watched(() =>
      o.lease(A, "draft", 600).then(
        () => "ok",
        (e: Error) => e.message,
      ),
    );
    expect(r.out).toBe("Песочница функций перезапускается");
    expect(r.ms).toBeGreaterThanOrEqual(550);
    expect(r.ticks).toBeGreaterThan(20);
    expect(r.heapMB).toBeLessThan(64);
    await starting;
  }, 30_000);
});
