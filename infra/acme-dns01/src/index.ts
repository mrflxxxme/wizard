// @wizard/acme-dns01 — cert-manager ACME DNS-01 webhook solver with per-provider DNS backends (deploy.yaml#cloud.domains.tls).
/** Backend selection by DNS_PROVIDER (timeweb | cloudru) and credential lookup (NAME or NAME_FILE). */

/** Cloud.ru Evolution DNS: zones, TXT upsert with value merge, async operations. */
export {
  CloudruApiError,
  CloudruDns,
  type CloudruDnsOptions,
  DEFAULT_API_URL,
  DEFAULT_AUTH_URL,
  type PublicRecord,
  type PublicZone,
} from "./backends/cloudru.js";
export { createBackend, DNS_PROVIDERS, type DnsProvider, envValue } from "./backends/index.js";
/** Timeweb Cloud DNS: one TXT record per challenge value. */
export { TIMEWEB_API_URL, TimewebApiError, TimewebDns, type TimewebDnsOptions } from "./backends/timeweb.js";
/** Name helpers. */
export { normalizeDomain, relativeName } from "./dns-util.js";
/** Front-proxy CA of kube-apiserver (extension-apiserver-authentication). */
export { type FrontProxyTrust, frontProxyTrust, readFrontProxyTrust } from "./kube.js";
/** HTTPS server: front-proxy client certificates requested, checked per request. */
export { createWebhookServer, type WebhookServerOptions } from "./server.js";
/** Webhook protocol: discovery, ChallengePayload Present/CleanUp, zone scope, caller checks. */
export {
  type CallerInfo,
  type ChallengeRequest,
  createWebhook,
  type DnsBackend,
  inScope,
  trusted,
  type WebhookOptions,
} from "./webhook.js";
