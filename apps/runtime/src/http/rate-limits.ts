// runtime.yaml#rate_limits (L2-28): requests per minute to the public API of a system host — /api/data, /api/fn and
// /api/pay* — per signed-in user, for anonymous visitors per client network (services.ipHmac: the address the trusted
// ingress reported, IPv6 by /64, keyed HMAC). Over the limit → 429 RATE_LIMITED with Retry-After before the route
// runs. Windows are per system, so one busy system does not touch the others. Unknown client address (in-process
// fetch) — anonymous calls are not counted, like the other per-IP limits of the runtime.
import { WizardError } from "@wizard/sdk";
import type { MiddlewareHandler } from "hono";
import { MinuteWindows } from "../sandbox/egress-fetch.js";
import type { RuntimeHonoEnv } from "./context.js";
import { errorResponse } from "./errors.js";
import { sessionOf } from "./subject.js";

/** Per-minute limits of runtime.yaml#rate_limits: {session, anonymous}. */
export const PUBLIC_API_LIMITS = {
  data: { session: 300, anonymous: 60 },
  functions: { session: 120, anonymous: 30 },
} as const;

export type PublicApiBucket = "data" | "fn" | "pay";

/** The limited bucket of a path; null — not limited here (auth, ai, files, events, v1 have their own limits). */
export function publicApiBucket(path: string): PublicApiBucket | null {
  const m = /^\/api\/(data|fn|pay)(?:\/|$)/.exec(path);
  return m ? (m[1] as PublicApiBucket) : null;
}

const RATE_LIMITED_RU = "Слишком много запросов — подождите минуту и попробуйте снова";

/** Middleware for /api/*: counts /api/data, /api/fn and /api/pay* calls and answers 429 over the limit. */
export function publicApiRateLimits(clock: () => Date): MiddlewareHandler<RuntimeHonoEnv> {
  const windows = new MinuteWindows(() => clock().getTime());
  return async (c, next) => {
    const bucket = publicApiBucket(c.req.path);
    if (!bucket) return next();
    const services = c.get("services");
    let who: string | null = null;
    try {
      const { subject } = await sessionOf(c);
      if (subject.id !== null) who = `u:${subject.id}`;
    } catch {
      // No session and no public role: the route answers 401 itself; the call is counted as anonymous.
    }
    const anonymous = who === null;
    if (anonymous) {
      const net = services.ipHmac?.(c.req.raw) ?? null;
      if (!net) return next();
      who = `ip:${net.toString("hex")}`;
    }
    const limits = bucket === "data" ? PUBLIC_API_LIMITS.data : PUBLIC_API_LIMITS.functions;
    const limit = anonymous ? limits.anonymous : limits.session;
    const key = `${c.get("system").schema}:${bucket}:${who}`;
    if (windows.take(key, limit)) return next();
    const now = clock().getTime();
    const res = errorResponse(
      new WizardError("RATE_LIMITED", { message: RATE_LIMITED_RU }),
      c.get("requestId"),
    );
    res.headers.set("Retry-After", String(60 - Math.floor((now % 60_000) / 1000)));
    return res;
  };
}
