// Request → Subject (runtime.yaml#permissions.algorithm step 1), cached on the request.
import { resolveSubject } from "../auth/session.js";
import type { Subject } from "../data/access.js";
import type { RuntimeContext } from "./context.js";

const cache = new WeakMap<Request, Promise<{ subject: Subject; token: string | null }>>();

export function sessionOf(c: RuntimeContext): Promise<{ subject: Subject; token: string | null }> {
  let p = cache.get(c.req.raw);
  if (!p) {
    p = resolveSubject(c.get("system"), c.req.header("cookie"), c.get("services").env);
    cache.set(c.req.raw, p);
  }
  return p;
}

/** Subject of the request; throws UNAUTHENTICATED without a session when the spec has no public role. */
export async function subjectOf(c: RuntimeContext): Promise<Subject> {
  return (await sessionOf(c)).subject;
}
