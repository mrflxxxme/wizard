// V3-05 acceptance 1: web_search over Yandex Search API v2 on recorded answers — request format, parsing, personal data
// removed from queries, cache, ≈ 30 searches per build, ₽ accounting and the journal; without the key or the folder
// search is off and only known addresses are read.
import { describe, expect, it } from "vitest";
import {
  createResearch,
  parseYandexXml,
  RESEARCH_LIMITS,
  type RecordedExchange,
  ResearchError,
  SEARCH_RUB_PER_REQUEST,
  searchStatus,
  YANDEX_SEARCH_ENDPOINT,
  yandexSearchBody,
} from "../../src/research/index.js";
import { KEY_ENV, loadExchanges, recordedResearch, TEST_FOLDER, TEST_KEY } from "./helpers.js";

const xmlOf = (x: RecordedExchange) =>
  Buffer.from((JSON.parse(x.body) as { rawData: string }).rawData, "base64").toString("utf8");

describe("Yandex Search API v2 request and answer", () => {
  it("POSTs JSON to /v2/web/search with Api-Key auth and folderId in the body, XML format", async () => {
    const { research, seen } = recordedResearch();
    await research.search("стоматология Казань услуги");
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req?.url).toBe(YANDEX_SEARCH_ENDPOINT);
    expect(req?.method).toBe("POST");
    expect(req?.headers.authorization).toBe(`Api-Key ${TEST_KEY}`);
    expect(req?.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(req?.body ?? "{}");
    expect(body).toEqual(
      yandexSearchBody({
        queryText: "стоматология Казань услуги",
        folderId: TEST_FOLDER,
        region: "225",
        page: 0,
      }),
    );
    expect(body).toMatchObject({
      query: { searchType: "SEARCH_TYPE_RU", queryText: "стоматология Казань услуги", page: "0" },
      folderId: TEST_FOLDER,
      responseFormat: "FORMAT_XML",
      l10n: "LOCALIZATION_RU",
      groupSpec: { groupMode: "GROUP_MODE_DEEP", groupsOnPage: "10", docsInGroup: "1" },
    });
  });

  it("parses the recorded XML into {title, url, snippet}: hlword dropped, entities decoded, duplicates once", async () => {
    const { research } = recordedResearch();
    const r = await research.search("стоматология Казань услуги");
    expect(r.found).toBe(2400);
    expect(r.cached).toBe(false);
    expect(r.hits.map((h) => h.url)).toEqual([
      "https://klinika-kazan.example/uslugi",
      "https://dent-reviews.example/kazan",
      "https://price-list.example/dental/kazan?from=search",
    ]);
    expect(r.hits[0]).toEqual({
      title: "Стоматология в Казани — услуги и цены",
      url: "https://klinika-kazan.example/uslugi",
      snippet: "Лечение кариеса, имплантация, чистка. Консультация — 500 ₽ … Работаем без выходных",
      domain: "klinika-kazan.example",
    });
    // No passages: the headline is the snippet.
    expect(r.hits[1]?.title).toBe("Рейтинг клиник «Казань» & отзывы");
    expect(r.hits[1]?.snippet).toBe("Сравнение 40 клиник по ценам и отзывам");
  });

  it('<error code="15"> is an empty result, not a failure; other codes fail', () => {
    const empty = loadExchanges().find((x) => x.key.startsWith("SEARCH абвгд")) as RecordedExchange;
    expect(parseYandexXml(xmlOf(empty))).toEqual({ hits: [], found: null, errorCode: 15 });
    expect(
      parseYandexXml('<yandexsearch><response><error code="32">limit</error></response></yandexsearch>')
        .errorCode,
    ).toBe(32);
  });

  it("nothing found → 0 hits and found 0; the request is still paid", async () => {
    const { research } = recordedResearch();
    const r = await research.search("абвгд несуществующий запрос");
    expect(r.hits).toEqual([]);
    expect(r.found).toBe(0);
    expect(research.usage().costRub).toBe(SEARCH_RUB_PER_REQUEST);
  });

  it("401 → SEARCH_AUTH without the server message; counted against the limit but not charged", async () => {
    const { research, log } = recordedResearch();
    const err = await research.search("ключ отозван").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect((err as ResearchError).code).toBe("SEARCH_AUTH");
    expect((err as ResearchError).message).not.toContain("Unauthenticated");
    expect(research.usage()).toMatchObject({ searches: 1, costRub: 0 });
    expect(log.calls.at(-1)).toMatchObject({ tool: "web_search", status: "error", errorCode: "SEARCH_AUTH" });
  });
});

describe("personal data never reaches the search engine", () => {
  it("names, phones and emails are removed from the query before sending (packages/pii scrub)", async () => {
    const { research, seen, log } = recordedResearch();
    const r = await research.search("клиника Иван Петров +7 912 345-67-89 отзывы");
    expect(r.query).toBe("клиника отзывы");
    const sent = JSON.parse(seen[0]?.body ?? "{}") as { query: { queryText: string } };
    expect(sent.query.queryText).toBe("клиника отзывы");
    expect(seen[0]?.body).not.toMatch(/Петров|912|345-67-89/);
    expect(log.calls[0]).toMatchObject({ scrubbed: true });
    expect(log.calls[0]?.piiCategoriesCount).toMatchObject({ phone_ru: 1 });
  });

  it("a query of personal data only is refused without a request", async () => {
    const { research, seen } = recordedResearch();
    await expect(research.search("ivan.petrov@mail.ru +7 912 345-67-89")).rejects.toMatchObject({
      code: "QUERY_EMPTY",
    });
    expect(seen).toHaveLength(0);
  });

  it("the journal keeps no query text: a hash, the tool, status, cost and counts only", async () => {
    const { research, log } = recordedResearch();
    await research.search("стоматология Казань услуги");
    const call = log.calls[0];
    expect(call).toMatchObject({
      tool: "web_search",
      status: "ok",
      runId: "run-1",
      orgId: "org-1",
      systemId: "sys-1",
      mode: "fixture",
      host: "searchapi",
      results: 3,
      costRub: SEARCH_RUB_PER_REQUEST,
    });
    expect(call?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(log.calls)).not.toContain("стоматология");
  });
});

describe("cache and the per-build limit", () => {
  it("a repeated query comes from the cache: no request, no charge, journal status cached", async () => {
    const { research, seen, log } = recordedResearch();
    await research.search("стоматология Казань услуги");
    const again = await research.search("  Стоматология   Казань услуги ");
    expect(again.cached).toBe(true);
    expect(again.hits).toHaveLength(3);
    expect(seen).toHaveLength(1);
    expect(research.usage()).toMatchObject({ searches: 1, cacheHits: 1, costRub: SEARCH_RUB_PER_REQUEST });
    expect(log.calls.map((c) => c.status)).toEqual(["ok", "cached"]);
  });

  it("the cache is shared through the store: another build reuses answers for free", async () => {
    const first = recordedResearch();
    await first.research.search("стоматология Казань услуги");
    const second = recordedResearch({ store: first.store });
    const r = await second.research.search("стоматология Казань услуги");
    expect(r.cached).toBe(true);
    expect(second.seen).toHaveLength(0);
    expect(second.research.usage().costRub).toBe(0);
  });

  it(`at most ${RESEARCH_LIMITS.searches} paid searches per build; the next is refused, cached ones still served`, async () => {
    expect(RESEARCH_LIMITS.searches).toBe(30);
    const template = loadExchanges().find((x) => x.key.startsWith("SEARCH стоматология")) as RecordedExchange;
    const queries = Array.from({ length: 31 }, (_, i) => `услуги клиники вариант ${i + 1}`);
    const exchanges = queries.map((q) => ({ ...template, key: `SEARCH ${q}|225|0` }));
    const { research, seen, log } = recordedResearch({ exchanges });
    for (const q of queries.slice(0, 30)) await research.search(q);
    const refused = await research.search(queries[30] as string).catch((e: unknown) => e);
    expect((refused as ResearchError).code).toBe("SEARCH_LIMIT");
    expect((refused as ResearchError).message).toContain("30");
    expect(seen).toHaveLength(30);
    const cached = await research.search(queries[0] as string);
    expect(cached.cached).toBe(true);
    expect(cached.remaining).toBe(0);
    const u = research.usage();
    expect(u).toMatchObject({ searches: 30, refused: 1, cacheHits: 1 });
    expect(u.costRub).toBeCloseTo(30 * SEARCH_RUB_PER_REQUEST, 6);
    expect(u.costRub).toBeCloseTo(14.64, 2);
    expect(log.calls.filter((c) => c.status === "refused")).toHaveLength(1);
  });

  it("parallel calls cannot overshoot the limit", async () => {
    const template = loadExchanges().find((x) => x.key.startsWith("SEARCH стоматология")) as RecordedExchange;
    const queries = Array.from({ length: 8 }, (_, i) => `параллельный запрос ${i + 1}`);
    const exchanges = queries.map((q) => ({ ...template, key: `SEARCH ${q}|225|0` }));
    const { research, seen } = recordedResearch({ exchanges, limits: { searches: 5 } });
    const out = await Promise.allSettled(queries.map((q) => research.search(q)));
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(5);
    expect(seen).toHaveLength(5);
  });
});

describe("without the key or the folder: known addresses only", () => {
  it.each([
    [{}, "YANDEX_SEARCH_API_KEY и YANDEX_FOLDER_ID"],
    [{ YANDEX_SEARCH_API_KEY: TEST_KEY }, "YANDEX_FOLDER_ID"],
    [{ YANDEX_FOLDER_ID: TEST_FOLDER }, "YANDEX_SEARCH_API_KEY"],
  ])("env %j → search off with the reason", async (env, missing) => {
    const st = searchStatus(env);
    expect(st.search).toBe(false);
    expect(st.reasonRu).toContain(`не задан ${missing}`);
    expect(st.reasonRu).toContain("только с известными адресами");
    const { research, seen, log } = recordedResearch({ env });
    expect(research.status).toMatchObject({ search: false, reasonRu: st.reasonRu });
    await expect(research.search("стоматология Казань услуги")).rejects.toMatchObject({
      code: "SEARCH_DISABLED",
    });
    expect(seen).toHaveLength(0);
    expect(log.calls[0]).toMatchObject({ status: "refused", errorCode: "SEARCH_DISABLED" });
    // Known addresses are still read.
    const page = await research.readPage("https://klinika-kazan.example/blog/kak-vybrat");
    expect(page.title).toContain("Как выбрать стоматологию");
  });

  it("both set → search on", () => {
    expect(searchStatus(KEY_ENV)).toEqual({ search: true, reasonRu: null });
  });
});

describe("modes: the live network only with WIZARD_RESEARCH_MODE=live", () => {
  it("by default (fixture mode, no recorded fetch) nothing goes to the network, even with the key", async () => {
    const research = createResearch({ env: { ...KEY_ENV } });
    expect(research.status.mode).toBe("fixture");
    await expect(research.search("стоматология Казань услуги")).rejects.toMatchObject({
      code: "FIXTURE_MISSING",
    });
    await expect(research.readPage("https://klinika-kazan.example/")).rejects.toMatchObject({
      code: "FIXTURE_MISSING",
    });
  });

  it("WIZARD_LLM_MODE=live alone does not switch research to live", () => {
    expect(createResearch({ env: { ...KEY_ENV, WIZARD_LLM_MODE: "live" } }).status.mode).toBe("fixture");
    expect(createResearch({ env: { ...KEY_ENV, WIZARD_RESEARCH_MODE: "live" } }).status.mode).toBe("live");
  });
});
