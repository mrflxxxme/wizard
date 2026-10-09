// Ports of the M1 stand (session auth, scripted builder): next to the M0 dev stand (4000/4100/5173, deploy.yaml#local).
export const M1 = { api: 4210, runtime: 4110, web: 5183, runtimeInternal: 4111 } as const;

/** Mail of the M1 stand (OTP codes, invites) as OutboxMailer JSON files; the specs read them. */
export const M1_OUTBOX = new URL("../../../.data/e2e-m1/outbox/", import.meta.url).pathname;

/** URL of the stand's own database (written at start): specs seed rows the UI only reads (M2-05 deletion journal). */
export const M1_DB_FILE = new URL("../../../.data/e2e-m1/db-url", import.meta.url).pathname;

/** Every request of the stand's mock model providers (T1 and T0) as JSON lines {provider, body} (M1-12). */
export const M1_LLM_LOG = new URL("../../../.data/e2e-m1/llm-requests.jsonl", import.meta.url).pathname;

// Ports of the M2 stand (WIZARD_MILESTONE=M2 rules, the platform YooKassa shop on YookassaMock; M2-11) and of its test
// checkout page (confirmation_url of the shop's payments).
export const M2 = { api: 4220, runtime: 4120, web: 5193, shop: 4320, runtimeInternal: 4121 } as const;

export const M2_OUTBOX = new URL("../../../.data/e2e-m2/outbox/", import.meta.url).pathname;

export const M2_DB_FILE = new URL("../../../.data/e2e-m2/db-url", import.meta.url).pathname;

export const M2_LLM_LOG = new URL("../../../.data/e2e-m2/llm-requests.jsonl", import.meta.url).pathname;

// Ports of the pilot stand (M2-15): the M2 rules with WIZARD_REGISTRATION=invite and WIZARD_PAYMENTS=off, no shop.
export const PILOT = { api: 4230, runtime: 4130, web: 5203, runtimeInternal: 4131 } as const;

export const PILOT_OUTBOX = new URL("../../../.data/e2e-pilot/outbox/", import.meta.url).pathname;

export const PILOT_DB_FILE = new URL("../../../.data/e2e-pilot/db-url", import.meta.url).pathname;

export const PILOT_LLM_LOG = new URL("../../../.data/e2e-pilot/llm-requests.jsonl", import.meta.url).pathname;

// Ports of the v3 stand (D78): WIZARD_BUILD_PIPELINE=v3 — the grill interview, three directions and the harness v3 on
// recorded model answers (stand/v3-models.ts). d76-dry.ts holds 4240/4140/4141.
export const V3 = { api: 4250, runtime: 4150, web: 5223, runtimeInternal: 4151 } as const;

export const V3_OUTBOX = new URL("../../../.data/e2e-v3/outbox/", import.meta.url).pathname;

export const V3_DB_FILE = new URL("../../../.data/e2e-v3/db-url", import.meta.url).pathname;

export const V3_LLM_LOG = new URL("../../../.data/e2e-v3/llm-requests.jsonl", import.meta.url).pathname;
