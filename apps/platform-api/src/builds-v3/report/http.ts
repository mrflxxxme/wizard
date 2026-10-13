// V4-04: HTTP responses of the steps of the brief's goal scenarios — the browser of G1 (GoalBrowserProvider) wrapped so
// every context it opens records the answers of documents and API calls, attributed to the scenario under check.
import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserContext, Request, Response } from "@playwright/test";
import { redact } from "@wizard/llm";
import type { GoalBrowser, GoalBrowserProvider } from "../../agents/goal-browser.js";
import type { ScenarioHttp } from "./types.js";

/** Per scenario at most this many responses are kept (the first ones and every failure). */
export const HTTP_PER_SCENARIO = 60;
const KEPT_TYPES = new Set(["document", "fetch", "xhr"]);

function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.endsWith("localhost") || u.hostname.includes(".")
      ? `${u.pathname}${u.search}`.slice(0, 200)
      : u.origin;
  } catch {
    return raw.slice(0, 200);
  }
}

export interface HttpRecorder {
  /** The provider for the scenario checks: its contexts record their responses. */
  provider(p: GoalBrowserProvider | null): GoalBrowserProvider | null;
  /** Runs one scenario's check: responses seen inside go to `scenario`. */
  scenario<T>(scenario: string, fn: () => Promise<T>): Promise<T>;
  responses(): ScenarioHttp[];
}

export function httpRecorder(): HttpRecorder {
  const current = new AsyncLocalStorage<string>();
  const out: ScenarioHttp[] = [];
  const count = new Map<string, number>();
  const push = (r: ScenarioHttp) => {
    const n = count.get(r.scenario) ?? 0;
    if (n >= HTTP_PER_SCENARIO && r.status < 400 && !r.failure) return;
    count.set(r.scenario, n + 1);
    out.push(r);
  };
  const watch = (ctx: BrowserContext, scenario: string) => {
    ctx.on("response", (res: Response) => {
      const req = res.request();
      const type = req.resourceType();
      if (!KEPT_TYPES.has(type)) return;
      const entry: ScenarioHttp = {
        scenario,
        method: req.method(),
        url: shortUrl(res.url()),
        status: res.status(),
        type,
      };
      if (res.status() >= 400 && type !== "document") {
        void res
          .text()
          .then((t) => push({ ...entry, body: redact(t.slice(0, 500)) }))
          .catch(() => push(entry));
        return;
      }
      push(entry);
    });
    ctx.on("requestfailed", (req: Request) => {
      if (!KEPT_TYPES.has(req.resourceType())) return;
      push({
        scenario,
        method: req.method(),
        url: shortUrl(req.url()),
        status: 0,
        type: req.resourceType(),
        failure: (req.failure()?.errorText ?? "failed").slice(0, 120),
      });
    });
  };
  const wrapBrowser = (browser: GoalBrowser): GoalBrowser =>
    new Proxy(browser, {
      get(target, prop, receiver) {
        if (prop === "newContext") {
          return async (...args: Parameters<GoalBrowser["newContext"]>) => {
            const ctx = await target.newContext(...args);
            const scenario = current.getStore();
            if (scenario) watch(ctx as unknown as BrowserContext, scenario);
            return ctx;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  return {
    provider(p) {
      if (!p) return null;
      return {
        available: () => p.available(),
        close: () => p.close(),
        async acquire(signal) {
          const lease = await p.acquire(signal);
          return lease ? { browser: wrapBrowser(lease.browser), release: () => lease.release() } : null;
        },
      };
    },
    scenario: (scenario, fn) => current.run(scenario, fn),
    responses: () => [...out],
  };
}
