// V3-05 acceptance 3: openapi.json, llms.txt and sitemap of a domain found and put into the documentation index with a
// cache — on recorded answers (fixtures/exchanges.json from fixtures/gen.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOC_PATHS,
  docsView,
  originOf,
  parseLlmsTxt,
  parseSitemap,
  summarizeOpenApi,
} from "../../src/research/index.js";
import { FIXTURES, recordedResearch } from "./helpers.js";

const PAY = "https://api.pay-docs.example";
const SHOP = "https://shop-docs.example";

describe("recorded answers", () => {
  it("fixtures/exchanges.json is what fixtures/gen.mjs generates (no hand edits)", async () => {
    const gen = (await import(pathToFileURL(join(FIXTURES, "gen.mjs")).href)) as { exchanges: () => unknown };
    expect(JSON.parse(readFileSync(join(FIXTURES, "exchanges.json"), "utf8"))).toEqual(gen.exchanges());
  });
});

describe("discovery of a domain", () => {
  it("llms.txt, openapi.json, api-catalog and sitemap.xml of an API domain go into the index", async () => {
    const { research, seen, log } = recordedResearch();
    const e = await research.discover("api.pay-docs.example");
    expect(e.origin).toBe(PAY);
    expect(seen.map((s) => s.url).sort()).toEqual(
      [
        `${PAY}/robots.txt`,
        PAY + DOC_PATHS.llms_txt,
        PAY + DOC_PATHS.openapi,
        PAY + DOC_PATHS.swagger,
        PAY + DOC_PATHS.api_catalog,
        `${PAY}/sitemap.xml`,
      ].sort(),
    );
    expect(e.sources.map((s) => [s.kind, s.found, s.status])).toEqual([
      ["llms_txt", true, 200],
      ["openapi", true, 200],
      ["swagger", false, 404],
      ["api_catalog", true, 200],
      ["sitemap", true, 200],
    ]);
    expect(e.llmsTxt).toMatchObject({
      title: "Pay Docs API",
      summary:
        "API приёма платежей: платежи, возвраты, чеки и уведомления. Документация для разработчиков и LLM.",
    });
    expect(e.llmsTxt?.sections.map((s) => s.title)).toEqual(["Документация", "Спецификации", "Optional"]);
    expect(e.llmsTxt?.sections[0]?.links[1]).toEqual({
      title: "Платежи",
      url: `${PAY}/developers/payments`,
      note: "создание, подтверждение и отмена",
    });
    expect(e.openapi).toMatchObject({
      url: `${PAY}/openapi.json`,
      spec: "openapi 3.1.0",
      title: "Pay Docs API",
      version: "3.0.0",
      servers: [`${PAY}/v3`],
      truncated: false,
    });
    expect(e.openapi?.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      "GET /payments",
      "POST /payments",
      "GET /payments/{payment_id}",
      "POST /payments/{payment_id}/capture",
      "POST /refunds",
      "POST /webhooks",
    ]);
    expect(e.openapi?.operations.at(-1)).toMatchObject({
      operationId: "createWebhook",
      summary: "Подписка на уведомления о событиях",
    });
    expect(e.apiCatalog?.links).toEqual([
      { rel: "service-desc", href: `${PAY}/openapi.json` },
      { rel: "service-doc", href: "https://pay-docs.example/developers" },
    ]);
    expect(e.sitemap?.urls).toEqual([`${PAY}/v3`, `${PAY}/v3/payments-guide`]);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatchObject({
      tool: "discover_docs",
      status: "ok",
      results: 4,
      host: "api.pay-docs.example",
    });
  });

  it("the index is cached: the second discovery (any spelling of the domain) makes no requests", async () => {
    const { research, seen, log } = recordedResearch();
    await research.discover("api.pay-docs.example");
    const n = seen.length;
    const again = await research.discover("https://api.pay-docs.example/developers/");
    expect(again.openapi?.title).toBe("Pay Docs API");
    expect(seen).toHaveLength(n);
    expect(log.calls.map((c) => c.status)).toEqual(["ok", "cached"]);
    expect(research.usage()).toMatchObject({ discover: 1, cacheHits: 1 });
  });

  it("raw documents are kept beside the index (for the integration harness)", async () => {
    const { research } = recordedResearch();
    await research.discover("api.pay-docs.example");
    const raw = await research.docs.raw(`${PAY}/openapi.json`);
    expect(JSON.parse(raw ?? "{}")).toMatchObject({ openapi: "3.1.0" });
    expect(await research.docs.raw(`${PAY}/llms.txt`)).toContain("# Pay Docs API");
    expect(await research.docs.get(PAY)).toMatchObject({ origin: PAY });
  });

  it("soft 404 (HTML with 200) is not documentation; Swagger 2.0 and a sitemap index named in robots.txt are", async () => {
    const { research, seen } = recordedResearch();
    const e = await research.discover("shop-docs.example");
    expect(seen.map((s) => s.url)).toContain(`${SHOP}/sitemap_index.xml`);
    expect(seen.map((s) => s.url)).not.toContain(`${SHOP}/sitemap.xml`);
    expect(e.llmsTxt).toBeNull();
    expect(e.sources.find((s) => s.kind === "openapi")).toMatchObject({ found: false, status: 200 });
    expect(e.openapi).toMatchObject({
      spec: "swagger 2.0",
      servers: ["https://shop-docs.example/api"],
      operations: [{ method: "GET", path: "/orders", operationId: "listOrders", summary: "Заказы" }],
    });
    expect(e.sitemap).toMatchObject({
      urls: [],
      sitemaps: [`${SHOP}/sitemap-1.xml`, `${SHOP}/sitemap-2.xml`],
    });
  });

  it("a domain without recorded documentation → nothing found, no failure", async () => {
    const { research } = recordedResearch();
    const e = await research.discover("klinika-kazan.example");
    expect(e.llmsTxt).toBeNull();
    expect(e.openapi).toBeNull();
    expect(e.sitemap?.urls).toHaveLength(3);
    expect(e.sources.filter((s) => s.errorCode === "FIXTURE_MISSING").map((s) => s.kind)).toEqual([
      "llms_txt",
      "openapi",
      "swagger",
      "api_catalog",
    ]);
  });

  it("internal addresses and the per-build limit are refused", async () => {
    const { research } = recordedResearch({ limits: { discover: 1 } });
    await expect(research.discover("http://10.0.0.1")).rejects.toMatchObject({ code: "EGRESS_PRIVATE" });
    await expect(research.discover("localhost")).rejects.toMatchObject({ code: "EGRESS_PRIVATE" });
    await research.discover("api.pay-docs.example");
    await expect(research.discover("shop-docs.example")).rejects.toMatchObject({ code: "DISCOVER_LIMIT" });
  });
});

describe("parsers and the model view", () => {
  it("originOf takes a domain or a URL", () => {
    expect(originOf("yookassa.ru")).toBe("https://yookassa.ru");
    expect(originOf("https://yookassa.ru/developers/api")).toBe("https://yookassa.ru");
    expect(() => originOf("ftp://x.example")).toThrow();
  });

  it("llms.txt needs an H1; links resolve against the file URL", () => {
    expect(parseLlmsTxt("<html>", "https://a.example/llms.txt")).toBeNull();
    expect(parseLlmsTxt("Просто текст", "https://a.example/llms.txt")).toBeNull();
    const l = parseLlmsTxt("# A\n- [B](/b): c", "https://a.example/llms.txt");
    expect(l?.sections[0]?.links[0]).toEqual({ title: "B", url: "https://a.example/b", note: "c" });
  });

  it("not a spec, not a sitemap → null", () => {
    expect(summarizeOpenApi('{"a":1}', "u")).toBeNull();
    expect(summarizeOpenApi("not json", "u")).toBeNull();
    expect(parseSitemap("<html></html>", "u")).toBeNull();
  });

  it("docsView filters links and operations by topic", async () => {
    const { research } = recordedResearch();
    const v = docsView(await research.discover("api.pay-docs.example"), "возврат refunds");
    expect(v.openapi?.operations.map((o) => o.operationId)).toEqual(["createRefund"]);
    expect(v.openapi?.operationsTotal).toBe(6);
    expect(v.llmsTxt?.links.map((l) => l.title)).toEqual(["Возвраты"]);
    expect(v.found.map((f) => f.kind)).toEqual(["llms_txt", "openapi", "api_catalog", "sitemap"]);
  });
});
