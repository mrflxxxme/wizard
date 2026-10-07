// B2-28: Chromium for the goal scenarios of a plan build (specs/quality/gates.yaml#G1.browser.platform): one headless
// browser per process, started on the first G1 that needs it and again after a crash; a limited number of builds use
// it at once (the others wait for a slot), every build gets its own contexts (gates opens them). Closed with the process.
import type { Browser } from "@playwright/test";
import type { GateContext } from "@wizard/gates";

/** Playwright browser as @wizard/gates takes it (GateContext.browser). */
export type GoalBrowser = NonNullable<GateContext["browser"]>;

export interface GoalBrowserLease {
  browser: GoalBrowser;
  /** Frees the slot (idempotent). */
  release(): void;
}

export interface GoalBrowserProvider {
  /** Whether builds get the browser checks: starts the browser on the first call; false — not installed or broken. */
  available(): Promise<boolean>;
  /**
   * The browser for one G1 run: waits for a free slot (the signal or `waitTimeoutMs` end the wait). null — no browser
   * (it does not start, the provider is closed or the wait ran out): G1 then reports the browser checks as errors.
   */
  acquire(signal?: AbortSignal): Promise<GoalBrowserLease | null>;
  close(): Promise<void>;
}

export interface ChromiumProviderOptions {
  /** G1 runs that use the browser at once (WIZARD_G1_BROWSER_SLOTS, default 2). */
  slots?: number;
  /** Launch of Chromium, ms (default 30 s). */
  launchTimeoutMs?: number;
  /** Wait for a slot, ms (default 10 min). */
  waitTimeoutMs?: number;
  /** After a failed launch the next try waits this long, ms (default 60 s): a missing browser is not retried per build. */
  retryAfterMs?: number;
  /** Starts the browser (tests); default Playwright's headless Chromium. */
  launch?: () => Promise<Browser>;
  /** Process log: browser_started, browser_failed, browser_closed (fixed fields, no system data). */
  log?: (msg: string, fields?: Record<string, string | number>) => void;
}

async function launchChromium(timeoutMs: number): Promise<Browser> {
  // Loaded on demand: processes that never build by a plan do not load Playwright.
  const { chromium } = await import("@playwright/test");
  return chromium.launch({
    headless: true,
    timeout: timeoutMs,
    // Containers give /dev/shm 64 MB; Chromium then writes shared memory to /tmp.
    args: ["--disable-dev-shm-usage"],
  });
}

export function chromiumProvider(o: ChromiumProviderOptions = {}): GoalBrowserProvider {
  const slots = Math.max(1, Math.floor(o.slots ?? 2));
  const launchTimeoutMs = o.launchTimeoutMs ?? 30_000;
  const waitTimeoutMs = o.waitTimeoutMs ?? 10 * 60_000;
  const retryAfterMs = o.retryAfterMs ?? 60_000;
  const launch = o.launch ?? (() => launchChromium(launchTimeoutMs));
  let current: Promise<Browser | null> | null = null;
  let failedAt = 0;
  let closed = false;
  let busy = 0;
  const waiting: (() => void)[] = [];

  const browser = (): Promise<Browser | null> => {
    if (closed) return Promise.resolve(null);
    if (current) return current;
    if (failedAt && Date.now() - failedAt < retryAfterMs) return Promise.resolve(null);
    const started = Date.now();
    const p = launch().then(
      (b) => {
        o.log?.("browser_started", { ms: Date.now() - started });
        b.on("disconnected", () => {
          // A crash (or close): the next G1 starts a new one.
          if (current === p) current = null;
          if (!closed) o.log?.("browser_closed", { reason: "disconnected" });
        });
        return b;
      },
      (e: unknown) => {
        failedAt = Date.now();
        if (current === p) current = null;
        o.log?.("browser_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
        return null;
      },
    );
    current = p;
    return p;
  };

  const slot = (signal?: AbortSignal): Promise<boolean> => {
    if (busy < slots) {
      busy += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = waiting.indexOf(grant);
        if (i >= 0) waiting.splice(i, 1);
        resolve(ok);
      };
      // A freed slot passes straight to the waiter (busy stays as it is).
      const grant = () => finish(true);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), waitTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(grant);
    });
  };

  const free = () => {
    const next = waiting.shift();
    if (next) next();
    else busy = Math.max(0, busy - 1);
  };

  return {
    async available() {
      const b = await browser();
      return b?.isConnected() === true;
    },

    async acquire(signal) {
      if (closed || signal?.aborted) return null;
      if (!(await slot(signal))) return null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        free();
      };
      let b = await browser();
      // Disconnected between two builds: start a new one once.
      if (b && !b.isConnected()) {
        if (current) current = null;
        b = await browser();
      }
      if (!b || closed) {
        release();
        return null;
      }
      return { browser: b, release };
    },

    async close() {
      closed = true;
      for (const w of waiting.splice(0)) w();
      const b = await (current ?? Promise.resolve(null));
      current = null;
      await b?.close().catch(() => {});
    },
  };
}
