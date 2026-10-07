// B2-38 stock keys in CI (tools/deploy/stock-ci.mjs, .github/workflows/stock.yml): check, probe and record against fake
// fetches — the probe of the photos stage keeps its caps (≤ 20 searches, ≤ 10 downloads), reports numbers only (no key,
// no URL, no author) as an annotation and the same lines in the issue «Стоки: проверка из CI»; without keys it does
// not ask anything; the recording keeps Pexels metadata only, with the keys scrubbed. No network.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureStockFetch } from "../../../packages/agents/src/builder/index.ts";
import { QUERIES } from "../../fixtures/stock/gen.mjs";
import {
  allocate,
  annotation,
  loadAgents,
  main,
  PROBE_BRIEFS,
  PROBE_LIMITS,
  postIssueComment,
  probeBriefs,
  probeLines,
  runCheck,
  runProbe,
  runRecord,
  STOCK_ISSUE_TITLE,
  scrubKeys,
} from "../stock-ci.mjs";

const PEXELS = "pexels-SECRET-0123456789";
const PIXABAY = "53000000-pixabaySECRETkey";
const KEYS = { PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY };
const tmp = mkdtempSync(join(tmpdir(), "wizard-stock-ci-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let agents;
beforeAll(async () => {
  agents = await loadAgents();
}, 60_000);

/** The fixture stock behind a counter of the requests by kind (search / image) and host. */
function counted(inner = fixtureStockFetch()) {
  const seen = { search: 0, image: 0, hosts: new Set(), urls: [] };
  const f = async (u, init) => {
    const url = new URL(u);
    seen.hosts.add(url.hostname);
    seen.urls.push(u);
    if (url.hostname.startsWith("api.") || url.pathname === "/api/") seen.search++;
    else seen.image++;
    return inner(u, init);
  };
  return { f, seen };
}

const noSecrets = (text) => {
  expect(text).not.toContain(PEXELS);
  expect(text).not.toContain(PIXABAY);
  expect(text).not.toMatch(/https?:\/\//);
  // Authors of the answers (synthetic fixtures name them so) never reach the result.
  expect(text).not.toMatch(/Автор фикстуры|fixture_author/);
};

describe("probe of the photos stage (fake stock)", () => {
  it("default briefs: photos from both stocks, the caps hold, numbers only", async () => {
    const { f, seen } = counted();
    const r = await runProbe({ env: KEYS, fetch: f, agents });
    expect(r.verdict).toBe("ok");
    expect(r.briefs.map((b) => b.id)).toEqual(PROBE_BRIEFS);
    expect(r.searches).toBeLessThanOrEqual(PROBE_LIMITS.searches);
    expect(r.downloads).toBeLessThanOrEqual(PROBE_LIMITS.downloads);
    expect(seen.search).toBeLessThanOrEqual(20);
    expect(seen.image).toBeLessThanOrEqual(10);
    expect(r.downloads).toBe(10);
    // Both stocks were downloaded from (the first provider alternates by brief).
    expect(r.providers.pexels.downloads).toBeGreaterThan(0);
    expect(r.providers.pixabay.downloads).toBeGreaterThan(0);
    for (const b of r.briefs) {
      expect(b.slots).toBeGreaterThan(0);
      expect(b.picked).toBeGreaterThan(0);
      expect(b.picked).toBeLessThanOrEqual(b.slots);
    }
    const picked = r.briefs.reduce((s, b) => s + b.picked, 0);
    expect(picked).toBe(10);
    const lines = probeLines(r);
    expect(lines[0]).toBe("Проба этапа фото: стоки работают");
    expect(lines).toContain("Ключи: Pexels — есть, Pixabay — есть");
    expect(lines.find((l) => l.startsWith("mvp-01-dental-clinic"))).toMatch(
      /^mvp-01-dental-clinic · стоматологическая клиника: мест 1, выбрано 1 \((pexels|pixabay) 1\); поисков \d+, найдено \d+; \d+\.\d с$/,
    );
    // mvp-02 has 7 places: the download cap leaves some with the theme graphic, and says why.
    expect(lines.find((l) => l.startsWith("mvp-02-renovation"))).toMatch(/без фото \d+ — лимит пробы/);
    expect(lines.at(-1)).toMatch(/^Итого: выбрано 10 из 16 мест; поисков \d+ из 20, скачиваний 10 из 10; /);
    noSecrets(lines.join("\n"));
  }, 120_000);

  it("smaller caps are kept exactly; the briefs input is validated", async () => {
    const { f, seen } = counted();
    const r = await runProbe({
      env: KEYS,
      fetch: f,
      agents,
      briefs: ["mvp-01-dental-clinic", "mvp-02-renovation", "mvp-10-yoga-subscription"],
      limits: { searches: 3, downloads: 2 },
    });
    expect(seen.search).toBeLessThanOrEqual(3);
    expect(seen.image).toBeLessThanOrEqual(2);
    expect(r.briefs.reduce((s, b) => s + b.picked, 0)).toBeLessThanOrEqual(2);
    expect(r.briefs.some((b) => b.limited > 0)).toBe(true);
    expect(probeBriefs("")).toEqual(PROBE_BRIEFS);
    expect(probeBriefs("mvp-01-dental-clinic,mvp-02-renovation,mvp-04-beauty-salon")).toHaveLength(3);
    expect(() => probeBriefs("mvp-01-dental-clinic;curl x")).toThrow(/briefs/);
    expect(() => probeBriefs("mvp-01-dental-clinic,mvp-02-renovation")).toThrow(/от 3 до 5/);
    expect(() => probeBriefs("hz-01-purchase-requests,hz-02-x,hz-03-y")).toThrow(/mvp/);
    expect(allocate([1, 7, 1, 1, 6], 10)).toEqual([1, 4, 1, 1, 3]);
    expect(allocate([2, 4, 2, 2, 6], 20)).toEqual([2, 4, 2, 2, 6]);
    expect(allocate([5, 5], 3)).toEqual([2, 1]);
  }, 120_000);

  it("no keys: nothing is asked, the verdict is an error annotation", async () => {
    let calls = 0;
    const r = await runProbe({
      env: { PEXELS_API_KEY: " ", PIXABAY_API_KEY: "" },
      fetch: async () => {
        calls++;
        return new Response("{}");
      },
      agents,
    });
    expect(calls).toBe(0);
    expect(r.verdict).toBe("no_keys");
    expect(probeLines(r)).toEqual([
      "Проба этапа фото: ключей нет — проверка не проводилась",
      "Ключи: Pexels — нет, Pixabay — нет",
    ]);
    const out = [];
    const code = await main(["probe"], {
      env: {},
      fetch: async () => new Response("{}"),
      log: (l) => out.push(l),
      agents,
    });
    expect(code).toBe(1);
    expect(out[0]).toMatch(/^::error title=Стоки: проба этапа фото::Проба этапа фото: ключей нет/);
  });

  it("a refused key: that stock «не работает: HTTP 401», the other still picks — a warning", async () => {
    const inner = fixtureStockFetch();
    const f = async (u, init) =>
      new URL(u).hostname === "api.pexels.com" ? new Response("{}", { status: 401 }) : inner(u, init);
    const r = await runProbe({ env: KEYS, fetch: f, agents });
    expect(r.verdict).toBe("partial");
    const lines = probeLines(r);
    expect(lines.find((l) => l.startsWith("Pexels:"))).toMatch(/не работает: HTTP 401 ×\d+$/);
    expect(lines.find((l) => l.startsWith("Pixabay:"))).toMatch(/— работает$/);
    expect(r.providers.pixabay.downloads).toBeGreaterThan(0);
    // Only Pixabay keyed: photos, but a warning (one stock unchecked).
    const one = await runProbe({ env: { PIXABAY_API_KEY: PIXABAY }, fetch: fixtureStockFetch(), agents });
    expect(one.verdict).toBe("partial");
    // Everything down: an error.
    const down = await runProbe({
      env: KEYS,
      fetch: async () => {
        throw new Error(`ECONNREFUSED ${PEXELS}`);
      },
      agents,
    });
    expect(down.verdict).toBe("fail");
    noSecrets(probeLines(down).join("\n"));
  }, 120_000);

  it("main probe: the annotation and the same lines in the issue (created once), keys scrubbed", async () => {
    const stock = fixtureStockFetch();
    const issues = [];
    const comments = [];
    const gh = [];
    const f = async (u, init = {}) => {
      const url = new URL(u);
      if (url.hostname !== "api.github.com") return stock(u, init);
      gh.push(`${init.method} ${url.pathname}`);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer gh-token");
      if (init.method === "GET") return Response.json(issues);
      const body = JSON.parse(init.body);
      if (url.pathname.endsWith("/issues")) {
        const issue = { number: 7, title: body.title };
        issues.push(issue);
        return Response.json(issue, { status: 201 });
      }
      comments.push(body.body);
      return Response.json({ html_url: "https://github.com/o/r/issues/7#c1" }, { status: 201 });
    };
    const env = { ...KEYS, GITHUB_TOKEN: "gh-token", GITHUB_REPOSITORY: "o/r", RUN_URL: "https://run" };
    for (let i = 0; i < 2; i++) {
      const out = [];
      expect(await main(["probe"], { env, fetch: f, log: (l) => out.push(l), agents })).toBe(0);
      expect(out[0]).toMatch(/^::notice title=Стоки: проба этапа фото::Проба этапа фото: стоки работают%0A/);
      for (const l of out) {
        expect(l).not.toContain(PEXELS);
        expect(l).not.toContain(PIXABAY);
      }
      // The comment carries the same lines as the annotation.
      const lines = out[0]
        .split("::")
        .slice(2)
        .join("::")
        .replace(/%0A/g, "\n")
        .replace(/%25/g, "%")
        .split("\n");
      expect(comments[i].split("\n")).toEqual([
        "### Проба стоков · [задание](https://run)",
        "",
        ...lines.map((l) => `- ${l}`),
      ]);
    }
    expect(issues).toEqual([{ number: 7, title: STOCK_ISSUE_TITLE }]);
    expect(gh.filter((x) => x === "POST /repos/o/r/issues")).toHaveLength(1);
    expect(comments).toHaveLength(2);
    // An API failure is a warning, never a failed probe.
    const failing = async (u, init) =>
      new URL(u).hostname === "api.github.com" ? new Response("no", { status: 403 }) : stock(u, init);
    const out = [];
    expect(await main(["probe"], { env, fetch: failing, log: (l) => out.push(l), agents })).toBe(0);
    expect(out.at(-1)).toBe(
      "::warning title=Стоки: issue::комментарий не опубликован: GitHub API GET /issues: HTTP 403",
    );
  }, 180_000);

  it("postIssueComment: without a token nothing is sent", async () => {
    expect(
      await postIssueComment({
        token: "",
        repo: "o/r",
        body: "x",
        fetch: async () => {
          throw new Error("no");
        },
      }),
    ).toBeNull();
  });
});

describe("check of the keys", () => {
  it("one annotation with both verdicts; exit 1 when a key is missing or refused; keys never printed", async () => {
    const f = async (u, init) => {
      const url = new URL(u);
      if (url.hostname === "api.pexels.com")
        return new Headers(init?.headers).get("authorization") === PEXELS
          ? Response.json({ photos: [] })
          : new Response("{}", { status: 401 });
      return url.searchParams.get("key") === PIXABAY
        ? Response.json({ hits: [] })
        : Response.json({}, { status: 400 });
    };
    const out = [];
    expect(await runCheck({ env: KEYS, fetch: f, log: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual([
      "::notice title=Фото со стоков::Pexels — действителен (HTTP 200); Pixabay — действителен (HTTP 200)",
    ]);
    out.length = 0;
    expect(
      await runCheck({
        env: { PEXELS_API_KEY: "bad-key-1", PIXABAY_API_KEY: "" },
        fetch: f,
        log: (l) => out.push(l),
      }),
    ).toBe(1);
    expect(out[0]).toBe(
      "::warning title=Фото со стоков::Pexels — недействителен (HTTP 401); Pixabay — нет ключа",
    );
    out.length = 0;
    expect(await main(["check"], { env: KEYS, fetch: f, log: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).not.toContain(PEXELS);
    expect(await main(["nonsense"], { env: {}, log: () => {} })).toBe(2);
  });

  it("scrubKeys and annotations escape their data", () => {
    expect(
      scrubKeys(`a ${PEXELS} b ${encodeURIComponent("k+y/=")}`, { pexels: PEXELS, pixabay: "k+y/=" }),
    ).toBe("a *** b ***");
    expect(annotation("notice", "T", "a%b\nc")).toBe("::notice title=T::a%25b%0Ac");
  });
});

describe("record of the Pexels answers", () => {
  /** A Pexels answer as the API gives it (fields the recording drops included), with a key slipped into it. */
  const live = (query) => ({
    page: 1,
    per_page: 15,
    total_results: 8000,
    next_page: `https://api.pexels.com/v1/search/?page=2&per_page=15&query=${encodeURIComponent(query)}&key=${PEXELS}`,
    photos: Array.from({ length: 15 }, (_, i) => ({
      id: 3_000_000 + i,
      width: i % 2 ? 4000 : 6000,
      height: i % 2 ? 6000 : 4000,
      url: `https://www.pexels.com/photo/real-photo-${3_000_000 + i}/`,
      photographer: `Real Person ${i}`,
      photographer_url: `https://www.pexels.com/@real-${i}`,
      photographer_id: 900 + i,
      avg_color: "#AABBCC",
      alt: `note ${PEXELS}`,
      src: {
        original: `https://images.pexels.com/photos/${3_000_000 + i}/pexels-photo-${3_000_000 + i}.jpeg`,
        large2x: `https://images.pexels.com/photos/${3_000_000 + i}/pexels-photo-${3_000_000 + i}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940`,
        tiny: "https://images.pexels.com/x.jpeg",
      },
    })),
  });

  it("the dictionary's Pexels answers, metadata only, keys scrubbed, Pixabay never; the file drives the stage offline", async () => {
    const dir = join(tmp, "rec");
    const asked = [];
    const f = async (u, init) => {
      const url = new URL(u);
      asked.push(url.hostname);
      expect(new Headers(init?.headers).get("authorization")).toBe(PEXELS);
      return Response.json(live(url.searchParams.get("query") ?? ""));
    };
    const out = [];
    const r = await runRecord({
      env: KEYS,
      fetch: f,
      agents,
      dir,
      queries: QUERIES,
      log: (l) => out.push(l),
    });
    expect(r).toMatchObject({ code: 0, recorded: QUERIES.length, errors: [] });
    expect(new Set(asked)).toEqual(new Set(["api.pexels.com"]));
    expect(asked.length).toBe(QUERIES.length);
    expect(readdirSync(dir)).toEqual(["pexels.recorded.json"]);
    const text = readFileSync(join(dir, "pexels.recorded.json"), "utf8");
    expect(text).not.toContain(PEXELS);
    expect(text).not.toContain(PIXABAY);
    const rec = JSON.parse(text);
    expect(Object.keys(rec)).toEqual(QUERIES.map(([q, o]) => `${q}|${o}`).sort());
    const first = rec["dental clinic daylight|landscape"];
    expect(Object.keys(first)).toEqual(["page", "per_page", "photos", "total_results"]);
    expect(Object.keys(first.photos[0])).toEqual([
      "id",
      "width",
      "height",
      "url",
      "photographer",
      "photographer_url",
      "src",
    ]);
    expect(Object.keys(first.photos[0].src)).toEqual(["original", "large2x"]);
    expect(first.photos[0].src.large2x).toMatch(/&wz=960x640$/);
    expect(first.photos[1].src.large2x).toMatch(/&wz=640x960$/);
    expect(out).toEqual([
      `::notice title=Стоки: запись фикстур::Pexels: записано запросов ${QUERIES.length} из ${QUERIES.length}, фото в ответах ${QUERIES.length * 15}. Pixabay не записывается: по условиям API ответы кешируются на 24 часа, а не хранятся.`,
    ]);
    // A second recording of the same answers changes nothing (the PR step then says «без изменений»).
    await runRecord({ env: KEYS, fetch: f, agents, dir, queries: QUERIES, log: () => {} });
    expect(readFileSync(join(dir, "pexels.recorded.json"), "utf8")).toBe(text);
  });

  it("without a Pexels key nothing is asked; failures are counted, never printed with the key", async () => {
    let calls = 0;
    const out = [];
    const none = await runRecord({
      env: { PIXABAY_API_KEY: PIXABAY },
      fetch: async () => {
        calls++;
        return new Response("{}");
      },
      agents,
      dir: join(tmp, "none"),
      queries: QUERIES,
      log: (l) => out.push(l),
    });
    expect(none.code).toBe(1);
    expect(calls).toBe(0);
    expect(out[0]).toMatch(/^::error title=Стоки: запись фикстур::нет ключа Pexels/);
    out.length = 0;
    const refused = await runRecord({
      env: KEYS,
      fetch: async () => new Response("{}", { status: 401 }),
      agents,
      dir: join(tmp, "refused"),
      queries: QUERIES,
      log: (l) => out.push(l),
    });
    expect(refused).toMatchObject({ code: 1, recorded: 0 });
    expect(out[0]).toContain(`ошибки: HTTP 401 ×${QUERIES.length}`);
    expect(out[0]).not.toContain(PEXELS);
  });
});
