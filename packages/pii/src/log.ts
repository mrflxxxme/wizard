// Allowlist logger (platform/deploy.yaml#cloud.observability.pii_in_logs, L3-08): only listed fields leave the
// process; strings pass scrub(); PG errors → {sqlstate, constraint}, provider errors → {status, code}.
import { scrub } from "./scrub.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogLine = Record<string, unknown>;

/** Fields a log line may carry; everything else is dropped. */
export const LOG_FIELDS: ReadonlySet<string> = new Set([
  "ts",
  "level",
  "svc",
  "msg",
  "requestId",
  "runId",
  "workflowId",
  "systemId",
  "orgId",
  "system",
  "env",
  "revision",
  "route",
  "method",
  "status",
  "durationMs",
  "step",
  "kind",
  "code",
  "sqlstate",
  "constraint",
  "attempts",
  "job",
  "entity",
  "fn",
  "reason",
  "queue",
  "workflow",
  "count",
  "rows",
  "url",
  "port",
  "pid",
  "mode",
  "err",
  "error",
]);

const MAX_STRING = 300;
const PG_SQLSTATE = /^[0-9A-Z]{5}$/;

function clean(s: string, max = MAX_STRING): string {
  return scrub(s.length > 4 * max ? s.slice(0, 4 * max) : s).text.slice(0, max);
}

/** URLs and routes without query string or fragment (values travel there). */
function stripQuery(s: string): string {
  return s.replace(/[?#].*$/s, "");
}

export interface SafeError {
  type: string;
  code?: string;
  sqlstate?: string;
  constraint?: string | null;
  status?: number;
  message?: string;
  stack?: string[];
}

/** An error reduced to allowlisted fields: PG {sqlstate, constraint}, providers {status, code}, else scrubbed text. */
export function safeError(e: unknown): SafeError {
  if (e === null || typeof e !== "object") return { type: typeof e, message: clean(String(e), 200) };
  const o = e as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "Error";
  const code = typeof o.code === "string" ? o.code : undefined;
  if (
    code &&
    PG_SQLSTATE.test(code) &&
    (name === "PostgresError" || "severity" in o || "routine" in o || "severity_local" in o)
  ) {
    const constraint = o.constraint_name ?? o.constraint;
    return { type: "pg", sqlstate: code, constraint: typeof constraint === "string" ? constraint : null };
  }
  const status =
    typeof o.status === "number" ? o.status : typeof o.statusCode === "number" ? o.statusCode : undefined;
  if (status !== undefined) return { type: "provider", status, ...(code ? { code } : {}) };
  if (name === "LlmError" && code) return { type: "llm", code };
  if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) return { type: name.slice(0, 60), code };
  const out: SafeError = { type: name.slice(0, 60) };
  if (typeof o.message === "string") out.message = clean(o.message, 200);
  if (typeof o.stack === "string") {
    // Frames only: the first line repeats the message.
    out.stack = o.stack
      .split("\n")
      .filter((l) => /^\s+at /.test(l))
      .slice(0, 6)
      .map((l) => l.trim().slice(0, 200));
  }
  return out;
}

/** Keeps allowlisted fields with primitive values; strings scrubbed and truncated; err/error via safeError. */
export function sanitizeLogLine(line: LogLine): LogLine {
  const out: LogLine = {};
  for (const [k, v] of Object.entries(line)) {
    if (!LOG_FIELDS.has(k) || v === undefined) continue;
    if (k === "err" || k === "error") {
      out[k] = typeof v === "string" ? clean(v, 200) : safeError(v);
      continue;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = clean(k === "url" || k === "route" ? stripQuery(v) : v);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: LogLine): void;
  info(msg: string, fields?: LogLine): void;
  warn(msg: string, fields?: LogLine): void;
  error(msg: string, err?: unknown, fields?: LogLine): void;
  /** A prebuilt line (runtime JSON sink): sanitized like the rest. */
  line(line: LogLine): void;
}

export interface LoggerOptions {
  /** Service name: platform-api | worker | runtime. */
  svc: string;
  /** Sink for one JSON line (default: stderr for warn/error, stdout otherwise). */
  write?: (json: string, level: LogLevel) => void;
  /** Lowest level written (default info). */
  level?: LogLevel;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-lines logger with the allowlist applied to every line. */
export function createLogger(o: LoggerOptions): Logger {
  const min = RANK[o.level ?? "info"];
  const write =
    o.write ??
    ((json: string, level: LogLevel) =>
      (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${json}\n`));
  const emit = (level: LogLevel, l: LogLine) => {
    if (RANK[level] < min) return;
    write(JSON.stringify(sanitizeLogLine({ ts: new Date().toISOString(), ...l, level, svc: o.svc })), level);
  };
  return {
    debug: (msg, f) => emit("debug", { ...f, msg }),
    info: (msg, f) => emit("info", { ...f, msg }),
    warn: (msg, f) => emit("warn", { ...f, msg }),
    error: (msg, err, f) => emit("error", { ...f, msg, ...(err !== undefined ? { err } : {}) }),
    line: (l) => {
      const level = (typeof l.level === "string" && l.level in RANK ? l.level : "info") as LogLevel;
      emit(level, l);
    },
  };
}
