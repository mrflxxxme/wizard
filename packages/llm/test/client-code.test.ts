// V3-32 (D77 (4), models.yaml#client_code): the agent for compatible repositories carries the client's code — its call
// types go only to models with inference in RF. Whatever the org policy, the payload, the hints, the build tier switch
// (week0), the T1 reserve (D76) or a user's own key (BYOK): T0 models of T0 providers, never Z.ai, never a gateway.
// No network: an in-process fetch records every host a call reaches.
import { describe, expect, test } from "vitest";
import {
  BYOK_CALL_TYPES,
  type ByokResolver,
  byokDecision,
  CALL_TYPES,
  type CallType,
  CLIENT_CODE_CALL_TYPES,
  createRegistry,
  createRouter,
  decideTier,
  LlmError,
  type LlmMessage,
  MemoryUsageSink,
  MODELS,
  type OrgPolicy,
  PROVIDERS,
  ROUTES,
  t1Forbidden,
} from "../src/index.js";

const ORG = "00000000-0000-4000-8000-0000000000c2";
const CODE = [
  'import { useState } from "react";',
  "export function Cart() {",
  "  const [items, setItems] = useState<string[]>([]);",
  '  return <button onClick={() => setItems([...items, "x"])}>{items.length}</button>;',
  "}",
].join("\n");
const PAYLOADS = {
  code: `Файл src/Cart.tsx:\n${CODE}`,
  pii: `${CODE}\n// контакт: Иван Петров, +7 916 123-45-67, ivan@example.ru`,
  strong: `${CODE}\n// паспорт 4510 123456`,
};
const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "Ты — агент репозитория." },
  { role: "user", content: text },
];
const POLICIES: (OrgPolicy | null)[] = [
  { ruOnly: false, t1Restricted: false },
  { ruOnly: true, t1Restricted: false },
  { ruOnly: false, t1Restricted: true },
  { ruOnly: false },
  null,
];

describe("client code call types are T0 by policy", () => {
  test("the list: repo_code and repo_review, known call types, never served by BYOK", () => {
    expect([...CLIENT_CODE_CALL_TYPES]).toEqual(["repo_code", "repo_review"]);
    for (const ct of CLIENT_CODE_CALL_TYPES) {
      expect(CALL_TYPES).toContain(ct);
      expect(BYOK_CALL_TYPES).not.toContain(ct);
    }
  });

  test("decideTier: T0 for every policy × payload × hint × build tier", () => {
    const seen = new Set<string>();
    for (const build of ["T1", "T0"] as const) {
      const reg = createRegistry({ buildDefaultTier: build }, {});
      for (const ct of CLIENT_CODE_CALL_TYPES)
        for (const orgPolicy of POLICIES)
          for (const text of Object.values(PAYLOADS))
            for (const hint of [undefined, false, true]) {
              const d = decideTier(
                {
                  callType: ct,
                  messages: msgs(text),
                  orgPolicy,
                  ...(hint === undefined ? {} : { containsPiiHint: hint }),
                },
                reg,
              );
              expect(d.tier, `${ct} ${JSON.stringify(orgPolicy)} ${hint}`).toBe("T0");
              seen.add(d.reason);
            }
    }
    // Never «default_T0»: the T1 reserve (D76) applies only to calls that are T0 by default alone.
    expect([...seen].sort()).toEqual(["callType_forbidden_T1", "policy_region_restricted", "policy_ru_only"]);
    for (const ct of CLIENT_CODE_CALL_TYPES) expect(t1Forbidden(ct, msgs("x"))).toBe(true);
  });

  test("routes: default T0, no T1 chain; every chain model is a T0 model of a T0 provider (inference in RF)", () => {
    for (const ct of CLIENT_CODE_CALL_TYPES) {
      const r = ROUTES[ct];
      expect(r.defaultTier).toBe("T0");
      expect(r.chain.T1).toBeUndefined();
      expect(r.chain.T0?.length).toBeGreaterThan(1);
      for (const id of r.chain.T0 ?? []) {
        const m = MODELS.find((x) => x.id === id);
        expect(m, id).toBeDefined();
        expect(m?.tier).toBe("T0");
        expect(m?.placement).toBe("internal");
        expect(PROVIDERS[m?.provider as keyof typeof PROVIDERS].tier).toBe("T0");
      }
    }
    // The reviewer's head is of another family than the agent's (it also gets avoidFamilies from the caller).
    expect(ROUTES.repo_review.chain.T0?.[0]).not.toBe(ROUTES.repo_code.chain.T0?.[0]);
  });

  test("BYOK: the user's key never serves client code (byokDecision refuses by call type)", () => {
    const reg = createRegistry({ buildDefaultTier: "T1" }, {});
    for (const ct of CLIENT_CODE_CALL_TYPES)
      expect(
        byokDecision(
          { callType: ct, messages: msgs(PAYLOADS.code), orgPolicy: { ruOnly: false, t1Restricted: false } },
          reg,
        ),
      ).toEqual({ ok: false, reason: "call_type" });
  });
});

/** In-process providers: the host decides who answers; every request is recorded. */
function providers(fail: (host: string) => boolean) {
  const hosts: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    hosts.push(u.host);
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    if (fail(u.host))
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    return new Response(
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: body.model ?? "m",
        choices: [{ index: 0, message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, hosts };
}

const ENV = {
  CLOUDRU_BASE_URL: "https://cloudru.test/v1",
  CLOUDRU_API_KEY: "k-cloudru",
  YANDEX_BASE_URL: "https://yandex.test/v1",
  YANDEX_API_KEY: "k-yandex",
  YANDEX_FOLDER_ID: "b1folder",
  ZAI_BASE_URL: "https://zai.test/v4",
  ZAI_API_KEY: "k-zai",
};
const RF_HOSTS = new Set(["cloudru.test", "yandex.test"]);

describe("router: client code never leaves RF", () => {
  for (const ct of CLIENT_CODE_CALL_TYPES)
    test(`${ct}: an open org, build tier T1, the T1 reserve on and a BYOK key → only RF hosts, T0 records`, async () => {
      const p = providers(() => false);
      const resolved: CallType[] = [];
      const byok: ByokResolver = {
        fetch: p.fetch,
        async resolve(_org, callType) {
          resolved.push(callType);
          return {
            keyId: "key-1",
            providerId: "openai",
            model: "gpt-x-pro",
            baseUrl: "https://gateway.user.test/v1",
            body: "openai",
            verified: false,
            apiKey: async () => "sk-user",
          };
        },
      };
      const sink = new MemoryUsageSink();
      const router = createRouter({
        mode: "live",
        env: ENV,
        registry: createRegistry({ buildDefaultTier: "T1" }, ENV),
        sink,
        fetch: p.fetch,
        byok,
        t1Reserve: true,
        sleep: async () => {},
      });
      const out = await router.route({
        callType: ct,
        messages: msgs(PAYLOADS.pii),
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: ORG },
      });
      expect(out.tier).toBe("T0");
      expect(out.routeReason).toBe("callType_forbidden_T1");
      expect(out.byok).toBeUndefined();
      expect(resolved).toEqual([]);
      expect(p.hosts.length).toBeGreaterThan(0);
      for (const h of p.hosts) expect(RF_HOSTS.has(h), h).toBe(true);
      expect(sink.records.every((r) => r.tier === "T0" && r.callType === ct)).toBe(true);
    });

  test("the whole T0 chain down: the call fails, and still nothing goes to Z.ai or a gateway", async () => {
    const p = providers(() => true);
    const router = createRouter({
      mode: "live",
      env: ENV,
      registry: createRegistry({ buildDefaultTier: "T1" }, ENV),
      sink: new MemoryUsageSink(),
      fetch: p.fetch,
      t1Reserve: true,
      sleep: async () => {},
    });
    const err = await router
      .route({
        callType: "repo_code",
        messages: msgs(PAYLOADS.code),
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: ORG },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("LLM_UNAVAILABLE");
    expect(p.hosts.length).toBeGreaterThan(0);
    for (const h of p.hosts) expect(RF_HOSTS.has(h), h).toBe(true);
  });

  test("an own vLLM (openai_compatible, T0) may serve client code; it is still RF", async () => {
    const env = {
      ...ENV,
      WIZARD_LLM_OPENAI_COMPAT_BASE_URL: "https://vllm.wizard.test/v1",
      WIZARD_LLM_OPENAI_COMPAT_MODELS: "qwen3-coder",
      WIZARD_LLM_OPENAI_COMPAT_ROUTES: "repo_code",
    };
    const reg = createRegistry({ buildDefaultTier: "T1" }, env);
    const head = reg.routes.repo_code.chain.T0?.[0] as string;
    const m = reg.models.find((x) => x.id === head);
    expect(m?.provider).toBe("openai_compatible");
    expect(m?.tier).toBe("T0");
    expect(reg.routes.repo_code.chain.T1).toBeUndefined();
  });
});
