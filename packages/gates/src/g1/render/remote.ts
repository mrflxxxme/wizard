// Host side of G1-RENDER-01 in the sandbox (M2-19): the modules of the render Worker (worker-host.mjs + the shared
// guest + this run's render.js), the bridge that answers the Worker's page fetches by render token, and one render
// as an HTTP call to the Worker's socket. The G1 host (platform-api executors) places the Worker with the sandbox
// orchestrator and serves the bridge on its RPC listener.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GuestFetch, RenderJob, RenderOutcome } from "./host.js";

const SRC = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** Main module: the host first (it installs the render globals), then the page bundle, which sets __wzApp. */
export const RENDER_MAIN = `import host from "./render-host.mjs";
import "./render.js";
export default host;
`;

/** Worker modules for workerd-config (WorkerdSystem.worker): main + named ES modules. */
export function renderWorkerModules(bundleCode: string): { main: string; modules: Record<string, string> } {
  return {
    main: RENDER_MAIN,
    modules: {
      "render-host.mjs": SRC("worker-host.mjs"),
      "render-guest.mjs": SRC("guest.mjs"),
      "render.js": bundleCode,
    },
  };
}

export type RenderAnswer = (req: GuestFetch) => Promise<{ status: number; body: string }>;

/** Page fetches of render Workers, answered by the render they belong to (one token per render call). */
export class RenderBridge {
  private readonly calls = new Map<string, RenderAnswer>();

  open(answer: RenderAnswer): { token: string; close(): void } {
    const token = randomBytes(32).toString("hex");
    this.calls.set(token, answer);
    return { token, close: () => this.calls.delete(token) };
  }

  /** POST /render-fetch {token, method, path, body} → {ok, status, body}; unknown or closed token → 403. */
  async fetch(req: Request): Promise<Response> {
    const deny = () => new Response(JSON.stringify({ ok: false }), { status: 403 });
    if (req.method !== "POST") return deny();
    let m: { token?: unknown; method?: unknown; path?: unknown; body?: unknown };
    try {
      m = (await req.json()) as typeof m;
    } catch {
      return deny();
    }
    const answer = typeof m.token === "string" ? this.calls.get(m.token) : undefined;
    if (!answer || typeof m.method !== "string" || typeof m.path !== "string") return deny();
    const r = await answer({
      method: m.method,
      path: m.path,
      body: typeof m.body === "string" ? m.body : null,
    }).catch(() => ({ status: 500, body: "" }));
    return new Response(JSON.stringify({ ok: true, status: r.status, body: r.body }), {
      headers: { "content-type": "application/json" },
    });
  }
}

/** One page render by the Worker at `endpoint`; page fetches come back through `bridge` to `answer`. */
export async function renderRemote(o: {
  endpoint: string;
  job: RenderJob & { id: number };
  answer: RenderAnswer;
  bridge: RenderBridge;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Promise<RenderOutcome> {
  const call = o.bridge.open(o.answer);
  try {
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(`${o.endpoint}/__wizard/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: call.token, job: o.job }),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
      return { kind: "crash", message: "render Worker unreachable" };
    }
    const out = (await res.json().catch(() => null)) as {
      t?: string;
      ok?: boolean;
      html?: string;
      error?: string;
      passes?: number;
      loading?: number;
      logs?: { level: string; text: string }[];
    } | null;
    if (!res.ok || !out || out.t !== "done")
      return { kind: "crash", message: `render Worker: HTTP ${res.status}` };
    return {
      kind: "done",
      ok: out.ok === true,
      ...(typeof out.html === "string" ? { html: out.html } : {}),
      ...(typeof out.error === "string" ? { error: out.error } : {}),
      ...(typeof out.passes === "number" ? { passes: out.passes } : {}),
      ...(typeof out.loading === "number" ? { loading: out.loading } : {}),
      logs: Array.isArray(out.logs)
        ? out.logs.slice(0, 50).map((l) => ({
            level: String(l?.level ?? ""),
            text: String(l?.text ?? "").slice(0, 500),
          }))
        : [],
    };
  } finally {
    call.close();
  }
}
