// Entry point of the egress-proxy deployment (security/isolation.yaml#M2.network, L3-24; image infra/docker/egress-proxy).
// Configuration (platform/deploy.yaml#cloud): WIZARD_RUNTIME_INTERNAL_URL, WIZARD_INTERNAL_TOKEN,
// WIZARD_EGRESS_DENIED_CIDRS (pod/service/node CIDRs, metadata), PORT (3128), HOST (0.0.0.0 in the cluster).
import { createLogger } from "@wizard/pii/log";
import { createEgressProxy } from "./sandbox/egress.js";
import { remoteCapabilityAuthorizer } from "./sandbox/egress-remote.js";

/** Always denied, whatever the deployment adds: link-local/metadata, CGNAT, loopback, private ranges. */
export const BASE_DENIED_CIDRS = [
  "169.254.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fd00::/8",
  "fe80::/10",
  "::1/128",
] as const;

const logger = createLogger({ svc: "egress-proxy" });
const runtimeInternalUrl = process.env.WIZARD_RUNTIME_INTERNAL_URL;
const internalToken = process.env.WIZARD_INTERNAL_TOKEN;
if (!runtimeInternalUrl || !internalToken) {
  logger.error("config_missing", undefined, {
    reason: "WIZARD_RUNTIME_INTERNAL_URL and WIZARD_INTERNAL_TOKEN",
  });
  process.exit(1);
}
const extra = (process.env.WIZARD_EGRESS_DENIED_CIDRS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const port = Number(process.env.PORT ?? 3128);
const host = process.env.HOST ?? "127.0.0.1";

const server = createEgressProxy({
  authorize: remoteCapabilityAuthorizer({ runtimeInternalUrl, internalToken }),
  deniedCidrs: [...BASE_DENIED_CIDRS, ...extra],
  log: (line) => logger.line(line),
});
server.listen(port, host, () => logger.info("listening", { port }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
