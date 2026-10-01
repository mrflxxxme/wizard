// Entry point of the cert-manager DNS-01 webhook solver (infra/helm/wizard, templates/acme-webhook.yaml).
// Env: GROUP_NAME, SOLVER_NAME (dns01), DNS_PROVIDER (timeweb | cloudru) and its credentials (backends/index.ts;
// NAME or NAME_FILE), ACME_ZONES (comma list), ALLOWED_USERS (comma list), TLS_DIR (/tls: tls.crt, tls.key),
// PORT (8443), NODE_EXTRA_CA_CERTS = the service-account CA (to read the front-proxy CA from the API server).
import { readFileSync } from "node:fs";
import { createBackend } from "./backends/index.js";
import { readFrontProxyTrust } from "./kube.js";
import { createWebhookServer } from "./server.js";
import { createWebhook } from "./webhook.js";

const env = process.env;
const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
const list = (name: string) =>
  (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const tlsDir = env.TLS_DIR ?? "/tls";
const saDir = "/var/run/secrets/kubernetes.io/serviceaccount";
const zones = list("ACME_ZONES");
const allowedUsers = list("ALLOWED_USERS");
const groupName = env.GROUP_NAME ?? "";
if (zones.length === 0 || allowedUsers.length === 0 || !groupName) {
  log({
    level: "error",
    msg: "config_missing",
    reason: "GROUP_NAME, ACME_ZONES and ALLOWED_USERS are required",
  });
  process.exit(1);
}
const trust = await readFrontProxyTrust({ token: readFileSync(`${saDir}/token`, "utf8").trim() });
const handle = createWebhook({
  groupName,
  solverName: env.SOLVER_NAME ?? "dns01",
  dns: createBackend(env),
  zones,
  allowedUsers,
  log,
});

const tls = () => ({ key: readFileSync(`${tlsDir}/tls.key`), cert: readFileSync(`${tlsDir}/tls.crt`) });
const server = createWebhookServer({ ...tls(), trust, handle });
// cert-manager renews the serving certificate in place: reload it hourly.
setInterval(() => server.setSecureContext({ ...tls(), ca: trust.ca }), 3_600_000).unref();
server.listen(Number(env.PORT ?? 8443), "0.0.0.0", () => log({ level: "info", msg: "listening", zones }));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
