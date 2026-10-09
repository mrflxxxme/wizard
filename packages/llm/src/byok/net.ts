// HTTP of BYOK calls: a user-given gateway address must not reach the platform's own network (SSRF). The host is
// checked when the key is saved (policy.ts hostViolation) and again at connect time on every DNS answer, so a name
// that later resolves to a private address is refused too. No proxy of ours is ever used (no geo-block workaround).
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { LLM_HTTP_TIMEOUT_MS } from "../providers.js";
import { isPrivateAddress } from "./policy.js";

export interface ByokFetchOptions {
  /** Tests and local stands only: loopback and private addresses are reachable. */
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup that fails on any private, loopback or link-local answer. */
function guardedLookup(hostname: string, options: { all?: boolean }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const e: NodeJS.ErrnoException = new Error("address not allowed");
      e.code = "EADDRNOTALLOWED";
      return cb(e, []);
    }
    if (options.all) return cb(null, list);
    const first = list[0] as LookupAddress;
    return cb(null, first.address, first.family);
  });
}

/** fetch for BYOK calls and key checks: guarded DNS, no redirects to elsewhere, long model timeouts. */
export function byokFetch(o: ByokFetchOptions = {}): typeof globalThis.fetch {
  const timeout = o.timeoutMs ?? LLM_HTTP_TIMEOUT_MS;
  const dispatcher = new Agent({
    headersTimeout: timeout,
    bodyTimeout: timeout,
    ...(o.allowPrivateNetwork ? {} : { connect: { lookup: guardedLookup as never } }),
  });
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      // A redirect would carry the Authorization header to a host nobody checked.
      redirect: "error",
      dispatcher,
    })) as unknown as typeof globalThis.fetch;
}
