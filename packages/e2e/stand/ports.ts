// Ports of the M1 stand (session auth, scripted builder): next to the M0 dev stand (4000/4100/5173, deploy.yaml#local).
export const M1 = { api: 4210, runtime: 4110, web: 5183 } as const;

/** Mail of the M1 stand (OTP codes, invites) as OutboxMailer JSON files; the specs read them. */
export const M1_OUTBOX = new URL("../../../.data/e2e-m1/outbox/", import.meta.url).pathname;

/** URL of the stand's own database (written at start): specs seed rows the UI only reads (M2-05 deletion journal). */
export const M1_DB_FILE = new URL("../../../.data/e2e-m1/db-url", import.meta.url).pathname;

/** Every request of the stand's mock model providers (T1 and T0) as JSON lines {provider, body} (M1-12). */
export const M1_LLM_LOG = new URL("../../../.data/e2e-m1/llm-requests.jsonl", import.meta.url).pathname;

// Ports of the M2 stand (WIZARD_MILESTONE=M2 rules, the platform YooKassa shop on YookassaMock; M2-11) and of its test
// checkout page (confirmation_url of the shop's payments).
export const M2 = { api: 4220, runtime: 4120, web: 5193, shop: 4320 } as const;

export const M2_OUTBOX = new URL("../../../.data/e2e-m2/outbox/", import.meta.url).pathname;

export const M2_DB_FILE = new URL("../../../.data/e2e-m2/db-url", import.meta.url).pathname;

export const M2_LLM_LOG = new URL("../../../.data/e2e-m2/llm-requests.jsonl", import.meta.url).pathname;
