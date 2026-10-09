// V3-33 BYOK in @wizard/llm: the provider list (data), the call types a user's key may serve, the base URL rules (direct
// for providers that accept RF, the user's gateway otherwise, no private hosts), the router hook (scrub before the call,
// free for the balance, llm_calls byok=true, the platform chain on failure) and the check call. No network: in-process
// fetch mocks and one loopback server for the guarded DNS.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BYOK_CALL_TYPES,
  BYOK_CATALOG,
  type ByokResolver,
  type ByokRoute,
  byokBaseUrl,
  byokDecision,
  byokFetch,
  byokLast4,
  byokModelVerified,
  CALL_TYPES,
  type CallType,
  checkByokKey,
  createRegistry,
  createRouter,
  findByokProvider,
  isPrivateAddress,
  type LlmMessage,
  MemoryUsageSink,
  type OrgPolicy,
  PolicyBus,
  type RouterOptions,
} from "../src/index.js";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const OPEN: OrgPolicy = { ruOnly: false, t1Restricted: false };
// A canary key: it must never show up in records, errors, reports or anything the tests can see but the HTTP header.
const KEY = "sk-canary-0123456789abcdefCANARYKEY";
const PHONE = "+7 912 345-67-89";
const EMAIL = "anna.petrova@example.ru";
/** Assertions on the key never print it (failure messages included): booleans only. */
const leaks = (v: unknown): boolean => (typeof v === "string" ? v : (JSON.stringify(v) ?? "")).includes(KEY);
const sentKey = (auth: string | null | undefined): boolean => auth === `Bearer ${KEY}`;
const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "You are the Wizard v3 builder." },
  { role: "user", content: text },
];
const reg = createRegistry({}, {});

const okBody = (model: string) => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
});

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

/** In-process fetch: `/byok-gw` is the user's gateway, `/zai` and `/cloudru` the platform providers. */
function mockFetch(byok: (s: Seen) => { status: number; body: unknown } | "hang") {
  const seen: Seen[] = [];
  const started: Array<() => void> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    const s: Seen = {
      url: u,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: String(init?.body ?? ""),
    };
    seen.push(s);
    for (const w of started.splice(0)) w();
    const answer = u.includes("/byok-gw") ? byok(s) : { status: 200, body: okBody("platform") };
    if (answer === "hang") {
      await new Promise((_, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) reject(sig.reason);
        sig?.addEventListener("abort", () => reject(sig.reason));
      });
    }
    const a = answer as { status: number; body: unknown };
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen, nextRequest: () => new Promise<void>((r) => started.push(r)) };
}

function resolverOf(fetch: typeof globalThis.fetch, over: Partial<ByokRoute> = {}) {
  const resolved: CallType[] = [];
  const reports: unknown[] = [];
  const resolver: ByokResolver = {
    fetch,
    async resolve(_org, callType) {
      resolved.push(callType);
      return {
        keyId: "key-1",
        providerId: "openai",
        model: "gpt-x-pro",
        baseUrl: "https://llm.gateway.example/byok-gw/v1",
        body: "openai",
        verified: false,
        apiKey: async () => KEY,
        ...over,
      };
    },
    report: (keyId, outcome) => {
      reports.push({ keyId, ...outcome });
    },
  };
  return { resolver, resolved, reports };
}

function mk(m: ReturnType<typeof mockFetch>, r: ByokResolver, extra: Partial<RouterOptions> = {}) {
  const sink = new MemoryUsageSink();
  const router = createRouter({
    mode: "live",
    env: {
      ZAI_BASE_URL: "https://platform.example/zai",
      ZAI_API_KEY: "platform-zai",
      CLOUDRU_BASE_URL: "https://platform.example/cloudru",
      CLOUDRU_API_KEY: "platform-cloudru",
    },
    sink,
    fetch: m.fetch,
    byok: r,
    sleep: async () => {},
    ...extra,
  });
  return { router, sink };
}

describe("provider list (providers.json) and call types", () => {
  test("the big western APIs block RF → only through the user's gateway; direct providers have a base URL", () => {
    for (const id of ["openai", "anthropic", "google", "xai", "gateway"]) {
      const p = findByokProvider(id);
      expect(p?.acceptsRu, id).toBe(false);
      expect(p?.baseUrl, id).toBeUndefined();
    }
    for (const p of BYOK_CATALOG.providers.filter((x) => x.acceptsRu))
      expect(p.baseUrl).toMatch(/^https:\/\//);
    expect(byokModelVerified(findByokProvider("zai") as never, "glm-5.3")).toBe(true);
    expect(byokModelVerified(findByokProvider("openai") as never, "gpt-x-pro")).toBe(false);
  });

  test("BYOK call types: authoring only; T0-only calls and the checks (techreview, audit, QA, critic) never", () => {
    // data-boundary.yaml#call_types: «  <callType>: { allowed: [T0, T1], t1_requires: scrub, … }» (no yaml dependency here).
    const yaml = readFileSync(new URL("../../../specs/security/data-boundary.yaml", import.meta.url), "utf8");
    for (const ct of BYOK_CALL_TYPES) {
      expect(CALL_TYPES).toContain(ct);
      const line = new RegExp(`^  ${ct}:\\s+\\{ allowed: \\[([^\\]]*)\\], t1_requires: (\\w+)`, "m").exec(
        yaml,
      );
      expect(line?.[1], ct).toBe("T0, T1");
      expect(line?.[2], ct).toBe("scrub");
    }
    for (const ct of [
      "techreview",
      "brief_extract",
      "research",
      "audit",
      "qa_generate",
      "qa_explain",
      "critic_visual",
      "import_mapping",
      "runtime_ai_extract",
      "runtime_ai_generate",
      "support",
    ] as const)
      expect(BYOK_CALL_TYPES).not.toContain(ct);
  });
});

describe("base URL policy (D77 (14б): no own geo-block workarounds)", () => {
  const zai = findByokProvider("zai") as NonNullable<ReturnType<typeof findByokProvider>>;
  const openai = findByokProvider("openai") as NonNullable<ReturnType<typeof findByokProvider>>;
  test("a provider accepting RF is called directly; a gateway is refused for it", () => {
    expect(byokBaseUrl(zai, null)).toEqual({ url: "https://api.z.ai/api/paas/v4" });
    expect(byokBaseUrl(zai, "https://proxy.example/v1")).toEqual({ violation: "gateway_not_allowed" });
  });
  test("a provider blocking RF needs the user's https gateway, never its own API host or a private network", () => {
    expect(byokBaseUrl(openai, "")).toEqual({ violation: "gateway_required" });
    expect(byokBaseUrl(openai, "https://api.openai.com/v1")).toEqual({ violation: "official_host" });
    expect(byokBaseUrl(openai, "https://eu.api.openai.com/v1")).toEqual({ violation: "official_host" });
    expect(byokBaseUrl(openai, "https://api.anthropic.com/v1")).toEqual({ violation: "official_host" });
    expect(byokBaseUrl(openai, "http://gw.example/v1")).toEqual({ violation: "insecure_url" });
    expect(byokBaseUrl(openai, "https://user:pw@gw.example/v1")).toEqual({ violation: "credentials_in_url" });
    expect(byokBaseUrl(openai, "https://gw.example/v1?key=1")).toEqual({ violation: "bad_url" });
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "db.internal",
      "intranet",
    ])
      expect(byokBaseUrl(openai, `https://${host}/v1`), host).toEqual({ violation: "private_host" });
    expect(byokBaseUrl(openai, "https://llm.my-company.example/openai/v1/")).toEqual({
      url: "https://llm.my-company.example/openai/v1",
    });
    expect(byokBaseUrl(openai, "http://127.0.0.1:9/v1", { allowPrivateNetwork: true })).toEqual({
      url: "http://127.0.0.1:9/v1",
    });
  });
  test("private addresses", () => {
    for (const ip of [
      "10.0.0.1",
      "172.20.1.1",
      "192.168.1.1",
      "100.64.0.1",
      "127.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "95.163.0.1", "2a00:1450::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  test("last 4 characters", () => expect(byokLast4(KEY)).toBe("YKEY"));
});

describe("byokDecision: the T1 rules apply in full", () => {
  const decide = (
    callType: CallType,
    text: string,
    extra: Partial<Parameters<typeof byokDecision>[0]> = {},
  ) => byokDecision({ callType, messages: msgs(text), orgPolicy: OPEN, ...extra }, reg);
  test("page code with a phone and an email → allowed, both masked; the build tier switch does not matter", () => {
    const d = byokDecision(
      { callType: "page_compose", messages: msgs(`Контакты: ${PHONE}, ${EMAIL}`), orgPolicy: OPEN },
      createRegistry({ buildDefaultTier: "T0" }, {}),
    );
    expect(d.ok).toBe(true);
    const text = JSON.stringify(d.ok ? d.messages : null);
    expect(text).not.toContain("912");
    expect(text).not.toContain(EMAIL);
    expect(text).toContain("[ТЕЛЕФОН_1]");
  });
  test("refusals: ruOnly, region unknown or restricted, PII hint, strong PII, raw interview with PII, checks, images", () => {
    expect(decide("page_compose", "x", { orgPolicy: { ruOnly: true, t1Restricted: false } })).toEqual({
      ok: false,
      reason: "policy_ru_only",
    });
    expect(decide("page_compose", "x", { orgPolicy: { ruOnly: false } })).toEqual({
      ok: false,
      reason: "policy_region_restricted",
    });
    expect(decide("page_compose", "x", { containsPiiHint: true })).toEqual({ ok: false, reason: "pii_hint" });
    expect(decide("page_compose", "Паспорт 4510 123456 выдан ОВД")).toMatchObject({ ok: false });
    expect(decide("interview_v3", `Звоните ${PHONE}`)).toEqual({
      ok: false,
      reason: "pii_detected_interview",
    });
    expect(decide("interview_v3", "Нужен сайт пекарни")).toMatchObject({ ok: true });
    expect(decide("techreview", "x")).toEqual({ ok: false, reason: "call_type" });
    expect(decide("brief_extract", "x")).toEqual({ ok: false, reason: "call_type" });
    const img: LlmMessage[] = [
      { role: "user", content: "x", attachments: [{ mime: "image/png", data: "AA==" }] },
    ];
    expect(byokDecision({ callType: "page_compose", messages: img, orgPolicy: OPEN }, reg)).toEqual({
      ok: false,
      reason: "attachments",
    });
  });
});

describe("router hook", () => {
  test("page_compose goes to the user's gateway scrubbed; free for the balance; llm_calls byok=true", async () => {
    const m = mockFetch(() => ({ status: 200, body: okBody("gpt-x-pro") }));
    const { resolver, resolved, reports } = resolverOf(m.fetch);
    const { router, sink } = mk(m, resolver);
    const out = await router.route({
      callType: "page_compose",
      messages: msgs(`Страница контактов: ${PHONE}, ${EMAIL}`),
      orgPolicy: OPEN,
      ctx: { orgId: ORG, runId: "00000000-0000-4000-8000-0000000000aa" },
    });
    // Leak checks first: a failing assertion below prints the objects.
    expect(leaks({ out, records: sink.records, reports }), "key in the result or journal").toBe(false);
    expect(out).toMatchObject({
      tier: "T1",
      model: "byok:gpt-x-pro",
      creditsCharged: 0,
      creditsMilli: 0,
      scrubbed: true,
      ruFallback: false,
      byok: true,
    });
    expect(resolved).toEqual(["page_compose"]);
    expect(m.seen).toHaveLength(1);
    const [req] = m.seen;
    expect(req?.url).toBe("https://llm.gateway.example/byok-gw/v1/chat/completions");
    expect(sentKey(req?.auth), "the key went in the header").toBe(true);
    expect(req?.body).not.toContain("912");
    expect(req?.body).not.toContain(EMAIL);
    expect(req?.body).toContain("[ТЕЛЕФОН_1]");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      byok: true,
      tier: "T1",
      scrubbed: true,
      provider: "byok:openai",
      modelId: "byok:gpt-x-pro",
      status: "ok",
      costRub: 0,
      creditsMilli: 0,
      billable: false,
      inputTokens: 1000,
      piiCategoriesCount: { phone_ru: 1, email: 1 },
    });
    expect(reports).toEqual([{ keyId: "key-1", ok: true, errorCode: null }]);
  });

  test("a rejected key (401 echoing the key) → journaled without the key, then the platform chain, charged", async () => {
    const m = mockFetch(() => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${KEY}` } },
    }));
    const { resolver, reports } = resolverOf(m.fetch);
    const { router, sink } = mk(m, resolver);
    const out = await router.route({
      callType: "page_compose",
      messages: msgs("Главная страница пекарни"),
      orgPolicy: OPEN,
      ctx: { orgId: ORG },
    });
    expect(leaks({ out, records: sink.records, reports }), "key in the result or journal").toBe(false);
    expect(out.byok).toBeUndefined();
    expect(out.model).toBe("glm-5.3");
    expect(out.creditsMilli).toBeGreaterThan(0);
    expect(m.seen.map((s) => (s.url.includes("/byok-gw") ? "byok" : "platform"))).toEqual([
      "byok",
      "platform",
    ]);
    expect(sink.records.map((r) => [r.byok ?? false, r.status, r.errorCode, r.billable])).toEqual([
      [true, "error", "HTTP_401", false],
      [false, "ok", null, true],
    ]);
    expect(reports).toEqual([{ keyId: "key-1", ok: false, errorCode: "HTTP_401" }]);
  });

  test("everything failing: the LLM_UNAVAILABLE error carries no key", async () => {
    const m = mockFetch(() => ({ status: 500, body: { error: { message: KEY } } }));
    const { resolver } = resolverOf(m.fetch);
    const sink = new MemoryUsageSink();
    const router = createRouter({
      mode: "live",
      env: {},
      sink,
      fetch: m.fetch,
      byok: resolver,
      sleep: async () => {},
    });
    const err = await router
      .route({ callType: "page_compose", messages: msgs("Страница"), orgPolicy: OPEN, ctx: { orgId: ORG } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { details?: unknown };
    expect(leaks(`${e.message} ${JSON.stringify(e.details)} ${e.stack ?? ""}`), "key in the error").toBe(
      false,
    );
    // Two BYOK attempts (5xx is retried once), no platform key in env → no platform request.
    expect(m.seen).toHaveLength(2);
    expect(leaks(sink.records), "key in llm_calls").toBe(false);
  });

  test("never for techreview, ruOnly orgs, fixture mode or a private gateway host", async () => {
    const m = mockFetch(() => ({ status: 200, body: okBody("gpt-x-pro") }));
    const { resolver, resolved } = resolverOf(m.fetch);
    const { router } = mk(m, resolver);
    await router.route({
      callType: "techreview",
      messages: msgs("Ревью"),
      orgPolicy: OPEN,
      ctx: { orgId: ORG },
    });
    await router.route({
      callType: "page_compose",
      messages: msgs("Страница"),
      orgPolicy: { ruOnly: true, t1Restricted: false },
      ctx: { orgId: ORG },
    });
    expect(resolved).toEqual([]);
    expect(m.seen.every((s) => !s.url.includes("/byok-gw"))).toBe(true);

    const priv = resolverOf(m.fetch, { baseUrl: "http://127.0.0.1:1/byok-gw/v1" });
    const p = mk(m, priv.resolver);
    const before = m.seen.length;
    const out = await p.router.route({
      callType: "page_compose",
      messages: msgs("Страница"),
      orgPolicy: OPEN,
      ctx: { orgId: ORG },
    });
    expect(out.byok).toBeUndefined();
    expect(m.seen.slice(before).every((s) => !s.url.includes("/byok-gw"))).toBe(true);
    expect(p.sink.records[0]).toMatchObject({
      byok: true,
      errorCode: "BYOK_URL_NOT_ALLOWED",
      status: "error",
    });
    expect(priv.reports).toEqual([{ keyId: "key-1", ok: false, errorCode: "BYOK_URL_NOT_ALLOWED" }]);
  });

  test("ruOnly switched on during a BYOK call → aborted and repeated on the RF models", async () => {
    const m = mockFetch(() => "hang");
    const { resolver } = resolverOf(m.fetch);
    const bus = new PolicyBus();
    const { router, sink } = mk(m, resolver, { policyBus: bus });
    const started = m.nextRequest();
    const p = router.route({
      callType: "page_compose",
      messages: msgs("Страница"),
      orgPolicy: OPEN,
      ctx: { orgId: ORG },
    });
    await started;
    bus.publish({ orgId: ORG, policy: { ruOnly: true, t1Restricted: false } });
    const out = await p;
    expect(out).toMatchObject({ tier: "T0", routeReason: "policy_ru_only" });
    expect(out.byok).toBeUndefined();
    expect(sink.records[0]).toMatchObject({ byok: true, status: "aborted", errorCode: "POLICY_CHANGED" });
    expect(bus.size).toBe(0);
  });

  test("fixture mode never calls a user's key", async () => {
    const m = mockFetch(() => ({ status: 200, body: okBody("x") }));
    const { resolver, resolved } = resolverOf(m.fetch);
    const router = createRouter({
      mode: "fixture",
      fixture: { suite: "unit", name: "byok-none", lenient: true, dir: "/nonexistent" },
      sink: new MemoryUsageSink(),
      byok: resolver,
    });
    await router
      .route({ callType: "page_compose", messages: msgs("x"), orgPolicy: OPEN, ctx: { orgId: ORG } })
      .catch(() => undefined);
    expect(resolved).toEqual([]);
  });
});

describe("checkByokKey", () => {
  const base = "https://llm.gateway.example/byok-gw/v1";
  const run = (answers: Record<string, { status: number; body: unknown }>, model = "gpt-x-pro") => {
    const m = mockFetch((s) => {
      const path = new URL(s.url).pathname.replace(/^.*\/v1/, "");
      return answers[path] ?? { status: 404, body: {} };
    });
    return { m, res: checkByokKey({ baseUrl: base, apiKey: KEY, model, fetch: m.fetch }) };
  };
  test("models list naming the model → ok without a chat call", async () => {
    const { m, res } = run({ "/models": { status: 200, body: { data: [{ id: "gpt-x-pro" }] } } });
    expect(await res).toEqual({ ok: true });
    expect(m.seen.map((s) => s.method)).toEqual(["GET"]);
    expect(sentKey(m.seen[0]?.auth), "the key went in the header").toBe(true);
  });
  test("no list → one tiny ping", async () => {
    const { m, res } = run({ "/chat/completions": { status: 200, body: okBody("gpt-x-pro") } });
    expect(await res).toEqual({ ok: true });
    expect(JSON.parse(m.seen[1]?.body ?? "{}")).toMatchObject({ max_tokens: 16 });
  });
  test("verdict codes; nothing of the answer comes back", async () => {
    const cases: [Record<string, { status: number; body: unknown }>, string][] = [
      [{ "/models": { status: 401, body: { error: KEY } } }, "KEY_INVALID"],
      [{ "/models": { status: 402, body: {} } }, "NO_BALANCE"],
      [{ "/models": { status: 429, body: { error: "rate limit" } } }, "RATE_LIMITED"],
      [
        { "/models": { status: 403, body: { error: { code: "unsupported_country_region_territory" } } } },
        "REGION_BLOCKED",
      ],
      [
        {
          "/models": { status: 200, body: { data: [{ id: "other" }] } },
          "/chat/completions": { status: 404, body: { error: "The model does not exist" } },
        },
        "MODEL_NOT_FOUND",
      ],
      [{ "/models": { status: 503, body: {} } }, "PROVIDER_ERROR"],
    ];
    for (const [answers, code] of cases) {
      const r = await run(answers).res;
      expect(leaks(r), "key in the verdict").toBe(false);
      expect(r, code).toEqual({ ok: false, code });
    }
    const down = (async () => {
      throw new Error(`connect ECONNREFUSED ${KEY}`);
    }) as unknown as typeof globalThis.fetch;
    expect(await checkByokKey({ baseUrl: base, apiKey: KEY, model: "m", fetch: down })).toEqual({
      ok: false,
      code: "UNREACHABLE",
    });
  });
});

describe("byokFetch: guarded DNS", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};
  beforeAll(async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://localhost:${(server.address() as AddressInfo).port}/`;
    close = () => new Promise<void>((ok) => server.close(() => ok()));
  });
  afterAll(() => close());
  test("a name resolving to a loopback address is refused; allowed only on local stands", async () => {
    await expect(byokFetch()(url)).rejects.toThrow();
    expect((await byokFetch({ allowPrivateNetwork: true })(url)).status).toBe(200);
  });
});
