// V3-05 acceptance 2: read_page by D46 — page → markdown (Readability + linkedom + Turndown), robots.txt, size and
// time limits, http(s) only, internal addresses refused (SSRF, also through redirects and DNS, and at connect time),
// no platform secrets in page requests; cache and the page limit.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  guardedTransport,
  htmlToMarkdown,
  isPrivateAddress,
  PAGE_MAX_BYTES,
  parseRobots,
  type RecordedExchange,
  type ResearchError,
} from "../../src/research/index.js";
import { decodeText } from "../../src/research/net.js";
import { recordedResearch, TEST_FOLDER, TEST_KEY } from "./helpers.js";

const CLINIC = "https://klinika-kazan.example";

describe("page → markdown", () => {
  it("the article: title, headings, lists and absolute links; no navigation, scripts, images or forms", async () => {
    const { research } = recordedResearch();
    const p = await research.readPage(`${CLINIC}/blog/kak-vybrat`);
    expect(p.title).toBe("Как выбрать стоматологию в Казани — блог клиники");
    expect(p.contentType).toBe("text/html");
    expect(p.finalUrl).toBe(`${CLINIC}/blog/kak-vybrat`);
    expect(p.markdown).toContain("## На что смотреть");
    expect(p.markdown).toMatch(/^-\s+Лицензия на медицинскую деятельность$/m);
    expect(p.markdown).toContain(`[в разделе услуг](${CLINIC}/uslugi#ceny)`);
    expect(p.markdown).toContain("имплантация под ключ — от 38 000 ₽");
    for (const noise of [
      "Главная",
      "Контакты",
      "window.metrika",
      "kabinet.jpg",
      "Записаться",
      "javascript:",
      "© 2026",
    ]) {
      expect(p.markdown).not.toContain(noise);
    }
    expect(p.truncated).toBe(false);
    expect(p.cached).toBe(false);
  });

  it("short pages fall back to the body without chrome", async () => {
    const html =
      "<html><head><title>Контакты</title></head><body><nav>Меню</nav><main><p>Казань, ул. Баумана, 1</p></main><footer>Подвал</footer></body></html>";
    const p = await htmlToMarkdown(html, "https://x.example/contacts");
    expect(p.title).toBe("Контакты");
    expect(p.markdown).toBe("Казань, ул. Баумана, 1");
  });

  it("markdown is cut at the size limit on a line end", async () => {
    const html = `<html><body><article>${Array.from({ length: 400 }, (_, i) => `<p>Абзац номер ${i} с текстом про услуги клиники и цены.</p>`).join("")}</article></body></html>`;
    const p = await htmlToMarkdown(html, "https://x.example/", 2000);
    expect(p.truncated).toBe(true);
    expect(p.markdown.length).toBeLessThanOrEqual(2000);
    expect(p.markdown.endsWith(".")).toBe(true);
  });

  it("text formats are returned as they are; other types are refused", async () => {
    const { research } = recordedResearch();
    const t = await research.readPage(`${CLINIC}/price.txt`);
    expect(t).toMatchObject({
      contentType: "text/plain",
      markdown: "Консультация 500\nЧистка 3500",
      title: "price.txt",
    });
    await expect(research.readPage(`${CLINIC}/price.pdf`)).rejects.toMatchObject({
      code: "UNSUPPORTED_TYPE",
    });
    await expect(research.readPage(`${CLINIC}/gone`)).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 404,
    });
  });

  it("windows-1251 pages are decoded by Content-Type or <meta charset>", () => {
    const bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» in cp1251
    expect(decodeText(bytes, "text/html; charset=windows-1251")).toBe("Привет");
    const html = new Uint8Array([...Buffer.from('<meta charset="windows-1251">'), ...bytes]);
    expect(decodeText(html, "text/html")).toContain("Привет");
  });
});

describe("redirects and robots.txt", () => {
  it("redirects are followed and re-checked; the final URL is reported", async () => {
    const { research, seen } = recordedResearch();
    const p = await research.readPage(`${CLINIC}/old-blog`);
    expect(p.finalUrl).toBe(`${CLINIC}/blog/kak-vybrat`);
    expect(seen.map((s) => s.url)).toEqual([
      `${CLINIC}/robots.txt`,
      `${CLINIC}/old-blog`,
      `${CLINIC}/blog/kak-vybrat`,
    ]);
  });

  it("a path disallowed by robots.txt is refused without requesting it; robots.txt is fetched once", async () => {
    const { research, seen, log } = recordedResearch();
    await expect(research.readPage(`${CLINIC}/private/card`)).rejects.toMatchObject({
      code: "ROBOTS_DISALLOWED",
    });
    await research.readPage(`${CLINIC}/blog/kak-vybrat`);
    expect(seen.map((s) => s.url)).toEqual([`${CLINIC}/robots.txt`, `${CLINIC}/blog/kak-vybrat`]);
    expect(log.calls[0]).toMatchObject({
      tool: "read_page",
      status: "refused",
      errorCode: "ROBOTS_DISALLOWED",
    });
  });

  it("RFC 9309 rules: own group over *, the longest match wins, Allow wins a tie, * and $", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /private/\nAllow: /private/open\nDisallow: /*.pdf$\n\nUser-agent: OtherBot\nDisallow: /\n\nSitemap: https://a.example/s.xml",
    );
    expect(r.allows("/blog")).toBe(true);
    expect(r.allows("/private/x")).toBe(false);
    expect(r.allows("/private/open/1")).toBe(true);
    expect(r.allows("/files/a.pdf")).toBe(false);
    expect(r.allows("/files/a.pdf?x=1")).toBe(true);
    expect(r.sitemaps).toEqual(["https://a.example/s.xml"]);
    const own = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: WizardResearchBot\nAllow: /\nDisallow: /admin",
    );
    expect(own.allows("/blog")).toBe(true);
    expect(own.allows("/admin/x")).toBe(false);
    expect(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a").allows("/a")).toBe(true);
  });

  it("robots.txt answering 5xx closes the site (unreachable), 4xx opens it", async () => {
    const page = "<html><body><article><p>Текст</p></article></body></html>";
    const ex = (host: string, robots: number): RecordedExchange[] => [
      {
        key: `GET https://${host}/robots.txt`,
        status: robots,
        headers: { "content-type": "text/plain" },
        body: "",
      },
      { key: `GET https://${host}/p`, status: 200, headers: { "content-type": "text/html" }, body: page },
    ];
    const { research } = recordedResearch({
      exchanges: [...ex("down.example", 503), ...ex("open.example", 404)],
    });
    await expect(research.readPage("https://down.example/p")).rejects.toMatchObject({
      code: "ROBOTS_DISALLOWED",
    });
    await expect(research.readPage("https://open.example/p")).resolves.toMatchObject({
      finalUrl: "https://open.example/p",
    });
  });
});

describe("SSRF and egress by D46", () => {
  it.each([
    ["http://127.0.0.1/", "EGRESS_PRIVATE"],
    ["http://localhost:4000/admin", "EGRESS_PRIVATE"],
    ["http://api.localhost/", "EGRESS_PRIVATE"],
    ["http://[::1]/", "EGRESS_PRIVATE"],
    ["http://10.1.2.3/", "EGRESS_PRIVATE"],
    ["http://172.20.0.5/", "EGRESS_PRIVATE"],
    ["http://192.168.1.1/router", "EGRESS_PRIVATE"],
    ["http://169.254.169.254/latest/meta-data/", "EGRESS_PRIVATE"],
    ["http://[fd00::1]/", "EGRESS_PRIVATE"],
    ["http://[::ffff:10.0.0.1]/", "EGRESS_PRIVATE"],
    ["http://2130706433/", "EGRESS_PRIVATE"], // 127.0.0.1 as a number
    ["http://metadata/", "EGRESS_PRIVATE"], // a single label resolves through search domains
    ["file:///etc/passwd", "SCHEME_FORBIDDEN"],
    ["ftp://files.example/a", "SCHEME_FORBIDDEN"],
    ["gopher://x.example/", "SCHEME_FORBIDDEN"],
    ["https://user:pass@site.example/", "URL_INVALID"],
    ["не адрес", "URL_INVALID"],
  ])("%s → %s, no request", async (url, code) => {
    const { research, seen, log } = recordedResearch();
    await expect(research.readPage(url)).rejects.toMatchObject({ code });
    expect(seen).toHaveLength(0);
    expect(log.calls[0]).toMatchObject({ tool: "read_page", status: "refused", errorCode: code });
    expect(research.usage().pages).toBe(0);
  });

  it("a public name resolving into the internal network is refused", async () => {
    const { research, seen } = recordedResearch({
      resolve: async (h) => (h === "rebind.example" ? ["93.184.215.14", "10.0.0.7"] : ["93.184.215.14"]),
    });
    await expect(research.readPage("https://rebind.example/")).rejects.toMatchObject({
      code: "EGRESS_PRIVATE",
    });
    expect(seen).toHaveLength(0);
  });

  it("a redirect into the internal network is refused before following it", async () => {
    const { research, seen } = recordedResearch();
    await expect(research.readPage(`${CLINIC}/go`)).rejects.toMatchObject({ code: "EGRESS_PRIVATE" });
    expect(seen.map((s) => s.url)).not.toContain("http://169.254.169.254/latest/meta-data/");
  });

  it("private ranges: loopback, RFC 1918, link-local, CGNAT, ULA, mapped IPv4; public stays public", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "::ffff:192.168.1.1",
      "garbage",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.215.14", "77.88.55.242", "172.32.0.1", "2a02:6b8::2:242"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  describe("connect-time check of the default transport", () => {
    let server: Server;
    let port = 0;
    let hits = 0;
    beforeAll(async () => {
      server = createServer((_req, res) => {
        hits++;
        res.end("secret internal page");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("a name that resolves to loopback only at connect time (DNS rebinding) never connects", async () => {
      const transport = guardedTransport(async () => ["127.0.0.1"]);
      const err = await transport(`http://public-looking.example:${port}/`).catch((e: unknown) => e);
      expect((err as ResearchError).code).toBe("EGRESS_PRIVATE");
      await expect(guardedTransport()(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
        code: "EGRESS_PRIVATE",
      });
      expect(hits).toBe(0);
    });
  });

  it("page requests carry no platform secrets: no key, no cookies, no authorization", async () => {
    const { research, seen } = recordedResearch();
    await research.search("стоматология Казань услуги");
    await research.readPage(`${CLINIC}/blog/kak-vybrat`);
    await research.discover("api.pay-docs.example");
    const pages = seen.filter((s) => !s.url.startsWith("https://searchapi.api.cloud.yandex.net/"));
    expect(pages.length).toBeGreaterThan(3);
    for (const s of pages) {
      expect(Object.keys(s.headers).sort()).toEqual([
        "accept",
        "accept-encoding",
        "accept-language",
        "user-agent",
      ]);
      expect(JSON.stringify(s)).not.toContain(TEST_KEY);
      expect(JSON.stringify(s)).not.toContain(TEST_FOLDER);
      expect(s.headers["user-agent"]).toContain("WizardResearchBot");
    }
  });
});

describe("limits, cache and the journal of pages", () => {
  it("over the size limit → TOO_LARGE", async () => {
    const big = "x".repeat(PAGE_MAX_BYTES + 10);
    const { research } = recordedResearch({
      exchanges: [
        {
          key: "GET https://big.example/p",
          status: 200,
          headers: { "content-type": "text/plain" },
          body: big,
        },
      ],
    });
    await expect(research.readPage("https://big.example/p")).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("a hanging site → TIMEOUT within the deadline", async () => {
    const { research } = recordedResearch({
      timeoutsMs: { page: 80 },
      fetch: (url, init) =>
        url.endsWith("/robots.txt")
          ? Promise.resolve(new Response("", { status: 404 }))
          : new Promise((_, reject) =>
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
            ),
    });
    const t0 = Date.now();
    const err = await research.readPage("https://slow.example/p").catch((e: unknown) => e);
    expect((err as ResearchError).code).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a page read twice comes from the cache; the page limit counts real reads only", async () => {
    const { research, seen, log } = recordedResearch({ limits: { pages: 1 } });
    await research.readPage(`${CLINIC}/blog/kak-vybrat`);
    const again = await research.readPage(`${CLINIC}/blog/kak-vybrat#top`);
    expect(again.cached).toBe(true);
    expect(seen.filter((s) => s.url.endsWith("/blog/kak-vybrat"))).toHaveLength(1);
    await expect(research.readPage(`${CLINIC}/price.txt`)).rejects.toMatchObject({ code: "PAGE_LIMIT" });
    expect(research.usage()).toMatchObject({ pages: 1, cacheHits: 1, refused: 1, costRub: 0 });
    expect(log.calls.map((c) => [c.tool, c.status, c.host])).toEqual([
      ["read_page", "ok", "klinika-kazan.example"],
      ["read_page", "cached", "klinika-kazan.example"],
      ["read_page", "refused", "klinika-kazan.example"],
    ]);
    expect(JSON.stringify(log.calls)).not.toContain("kak-vybrat");
  });
});
