// Runtime side of RUNTIME_RPC (security/isolation.yaml#M2.runtime, L3-23): the sandbox Worker reaches ctx.db,
// ctx.systemDb, ctx.scheduler, ctx.run* and ctx.connectors only through POST /rpc/<systemId>/<env> with the
// capability token of the call it serves. The runtime keeps the host ctx of every call in flight; a token that is
// forged, expired, issued for another system or for a call that already ended gets 403 and reaches nothing.
import { WizardError } from "@wizard/sdk";
import { type ChildMsg, dispatch, errorPayload, type HostCtx, isFatalHostError } from "../exec/executor.js";
import {
  type Capability,
  issueCapability,
  newRequestId,
  type SandboxEnv,
  verifyCapability,
} from "./capability.js";

export interface SandboxRpcOptions {
  /** HMAC key of capability tokens (≥ 32 bytes); never leaves the runtime. */
  key: Uint8Array;
  /** ms since epoch; default Date.now. */
  clock?: () => number;
  /** Request body limit (default 1 MiB). */
  maxBodyBytes?: number;
  /** Denied requests (reason only, never the token). */
  log?: (line: Record<string, unknown>) => void;
}

export interface OpenCallInput {
  systemId: string;
  env: SandboxEnv;
  hostCtx: HostCtx;
  /** Wall limit of the call: the token expires with it. */
  timeoutMs: number;
}

/** One call in flight; close() revokes its token. */
export interface OpenCall {
  readonly token: string;
  readonly requestId: string;
  /** Host error that must fail the call even if guest code swallowed it (see isFatalHostError). */
  readonly fatal: unknown;
  close(): void;
}

interface Entry {
  cap: Capability;
  hostCtx: HostCtx;
  fatal: unknown;
}

const RPC_PATH_RE = /^\/rpc\/([a-z0-9][a-z0-9_]{0,62})\/(draft|prod)$/;
const LOG_LEVELS = new Set(["info", "warn", "error"]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const denied = () => json(403, { error: { code: "FORBIDDEN" } });

function own(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null && Object.hasOwn(o, key)
    ? (o as Record<string, unknown>)[key]
    : undefined;
}

export class SandboxRpc {
  private readonly calls = new Map<string, Entry>();
  private readonly clock: () => number;
  private readonly maxBody: number;

  constructor(private readonly o: SandboxRpcOptions) {
    if (o.key.byteLength < 32) throw new Error("sandbox RPC key must be at least 32 bytes");
    this.clock = o.clock ?? Date.now;
    this.maxBody = o.maxBodyBytes ?? 1 << 20;
  }

  /** Calls in flight (tests, metrics). */
  get size(): number {
    return this.calls.size;
  }

  /** Registers a call and issues its token {systemId, env, requestId, exp = now + timeoutMs}. */
  open(i: OpenCallInput): OpenCall {
    const requestId = newRequestId();
    const cap: Capability = {
      systemId: i.systemId,
      env: i.env,
      requestId,
      exp: this.clock() + Math.max(1, Math.ceil(i.timeoutMs)),
    };
    const entry: Entry = { cap, hostCtx: i.hostCtx, fatal: undefined };
    this.calls.set(requestId, entry);
    const calls = this.calls;
    return {
      token: issueCapability(this.o.key, cap),
      requestId,
      get fatal() {
        return entry.fatal;
      },
      close() {
        calls.delete(requestId);
      },
    };
  }

  private deny(reason: string, extra: Record<string, unknown> = {}): Response {
    this.o.log?.({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "sandbox_rpc_denied",
      reason,
      ...extra,
    });
    return denied();
  }

  /** Handler of the RPC listener (internal port only; NetworkPolicy lets only sandbox pods reach it). */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = RPC_PATH_RE.exec(url.pathname);
    if (!m) return json(404, { error: { code: "NOT_FOUND" } });
    if (req.method !== "POST") return json(405, { error: { code: "METHOD_NOT_ALLOWED" } });
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return this.deny("no_token");
    const check = verifyCapability(this.o.key, token, this.clock());
    if (!check.ok) return this.deny(check.reason);
    const { cap } = check;
    if (cap.systemId !== m[1] || cap.env !== m[2]) return this.deny("system_mismatch", { system: m[1] });
    const entry = this.calls.get(cap.requestId);
    // A valid signature is not enough: the call must still be running and belong to the same system.
    if (
      !entry ||
      entry.cap.systemId !== cap.systemId ||
      entry.cap.env !== cap.env ||
      entry.cap.exp !== cap.exp
    ) {
      return this.deny("call_not_open", { system: cap.systemId });
    }
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > this.maxBody) return json(413, { error: { code: "PAYLOAD_TOO_LARGE" } });
    const text = await req.text();
    if (Buffer.byteLength(text) > this.maxBody) return json(413, { error: { code: "PAYLOAD_TOO_LARGE" } });
    let msg: ChildMsg;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
      msg = parsed as ChildMsg;
    } catch {
      return json(400, { error: { code: "VALIDATION_FAILED" } });
    }
    if (msg.op === "log") {
      const level = String(msg.level);
      const fn = own(own(entry.hostCtx, "log"), level);
      if (LOG_LEVELS.has(level) && typeof fn === "function") {
        const fields = typeof msg.fields === "object" && msg.fields !== null ? msg.fields : {};
        fn(String(msg.msg).slice(0, 1000), fields);
      }
      return json(200, { ok: true, value: null });
    }
    try {
      const value = await dispatch(entry.hostCtx, msg);
      return json(200, { ok: true, value: value === undefined ? null : value });
    } catch (e) {
      if (isFatalHostError(e)) entry.fatal ??= e;
      return json(200, {
        ok: false,
        error: errorPayload(e instanceof Error ? e : new WizardError("INTERNAL")),
      });
    }
  }
}
