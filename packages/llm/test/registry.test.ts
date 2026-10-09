// Registry lint (data-boundary.yaml#routing.model_registry, models.yaml#catalog_rules) and drift check against models.yaml.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CALL_TYPES, MODELS, PROVIDERS, ROUTES } from "../src/index.js";

const YAML = readFileSync(new URL("../../../specs/agents/models.yaml", import.meta.url), "utf8");
const num = (s: string) => Number(s);

describe("registry mirrors specs/agents/models.yaml", () => {
  test("models: provider, providerModel, tier, placement, context, price, enabled, vision, image", () => {
    const re =
      /^\s*- \{ id: ([\w.-]+),\s*provider: (\w+),\s*providerModel: "([^"]+)",\s*tier: (T[01]),\s*placement: (\w+),\s*context: (\d+),\s*price: \{ input: ([\d.]+),\s*cached: ([\d.]+),\s*output: ([\d.]+) \},\s*enabled: (true|false)(,\s*vision: true)?(?:,\s*image: \{ px: (\d+), max: (\d+) \})?/gm;
    const fromYaml = [...YAML.matchAll(re)].map((x) => ({
      id: x[1],
      provider: x[2],
      providerModel: x[3],
      tier: x[4],
      placement: x[5],
      context: num(x[6] as string),
      price: { input: num(x[7] as string), cached: num(x[8] as string), output: num(x[9] as string) },
      enabled: x[10] === "true",
      ...(x[11] ? { vision: true } : {}),
      ...(x[12] ? { image: { px: num(x[12]), max: num(x[13] as string) } } : {}),
    }));
    expect(fromYaml.length).toBeGreaterThan(0);
    expect(MODELS).toEqual(fromYaml);
  });

  test("routes: role, default tier, chains, temperature, max_tokens, timeout", () => {
    for (const ct of CALL_TYPES) {
      const lineRe = new RegExp(
        `^\\s*${ct}:\\s*\\{ role: (\\w+),\\s*default_tier: (T[01]),\\s*chain: \\{([^}]*)\\},\\s*temperature: ([\\d.]+),\\s*max_tokens: (\\d+),\\s*timeout_ms: (\\d+)`,
        "m",
      );
      const x = YAML.match(lineRe);
      expect(x, ct).not.toBeNull();
      if (!x) continue;
      const chain: Record<string, string[]> = {};
      for (const c of (x[3] as string).matchAll(/(T[01]): \[([^\]]*)\]/g)) {
        chain[c[1] as string] = (c[2] as string).split(",").map((s) => s.trim());
      }
      expect(ROUTES[ct], ct).toEqual({
        role: x[1],
        defaultTier: x[2],
        chain,
        temperature: num(x[4] as string),
        maxTokens: num(x[5] as string),
        timeoutMs: num(x[6] as string),
      });
    }
  });

  test("providers: env names", () => {
    for (const p of Object.values(PROVIDERS)) {
      const block = YAML.slice(YAML.indexOf(`  ${p.id}:\n`)).split(/\n {2}\w+:\n/)[0] ?? "";
      expect(block).toContain(`base_url_env: ${p.baseUrlEnv}`);
      expect(block).toContain(`api_key_env: ${p.apiKeyEnv}`);
      expect(block).toContain(`prompt_cache: ${p.promptCache}`);
    }
  });
});

describe("registry lint", () => {
  const FORBIDDEN_HOSTS = /openai\.com|anthropic\.com|googleapis\.com|google\.com|x\.ai|vercel|gateway/i;

  test("no Anthropic/OpenAI/Google/xAI providers or base URLs (checks provider and baseUrl, not the model name)", () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(["cloudru", "yandex", "zai", "moonshot", "deepseek", "openai_compatible"]).toContain(p.id);
      expect(p.defaultBaseUrl).not.toMatch(FORBIDDEN_HOSTS);
    }
  });

  test("T0 = internal placement on a T0 provider; every chain model exists and sits in its tier", () => {
    for (const x of MODELS) {
      if (x.tier === "T0") {
        expect(x.placement).toBe("internal");
        expect(PROVIDERS[x.provider].tier).toBe("T0");
      } else expect(PROVIDERS[x.provider].tier).toBe("T1");
    }
    for (const ct of CALL_TYPES) {
      for (const [tier, ids] of Object.entries(ROUTES[ct].chain)) {
        for (const id of ids) expect(MODELS.find((x) => x.id === id)?.tier, `${ct}:${id}`).toBe(tier);
      }
      expect(ROUTES[ct].chain.T0?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("Yandex requires x-data-logging-enabled: false", () => {
    expect(PROVIDERS.yandex.requiredHeaders).toEqual({ "x-data-logging-enabled": "false" });
  });

  test("T1 providers: termsCheckedAt present; older than 90 days → CI warning", () => {
    for (const p of Object.values(PROVIDERS).filter((x) => x.tier === "T1")) {
      expect(p.termsCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const age = (Date.now() - Date.parse(p.termsCheckedAt as string)) / 86_400_000;
      if (age > 90) console.warn(`::warning::${p.id}: условия T1 не проверялись ${Math.floor(age)} дней`);
    }
  });

  test("no provider keys in source", () => {
    const src = new URL("../src/", import.meta.url).pathname;
    // Subfolders too (src/byok, V3-33).
    for (const f of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!/\.(ts|json)$/.test(f)) continue;
      const text = readFileSync(join(src, f), "utf8");
      expect(text, f).not.toMatch(
        /\b(sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{16,}|AQVN[A-Za-z0-9_-]{20,})/,
      );
      expect(text, f).not.toMatch(/apiKey:\s*["'`][^"'`]+["'`]/);
    }
  });
});
