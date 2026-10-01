// Client address of a request (runtime.yaml#auth.anti_abuse). The Node server records the socket address, or the
// X-Forwarded-For hop added by a trusted ingress (platform/deploy.yaml#cloud.client_ip, WIZARD_TRUSTED_PROXIES).
const addresses = new WeakMap<Request, string>();

export function rememberClientIp(req: Request, address: string | undefined | null): void {
  if (address) addresses.set(req, address);
}

/** null when unknown (in-process fetch in tests): per-IP limits are then skipped. */
export function clientIpOf(req: Request): string | null {
  return addresses.get(req) ?? null;
}
