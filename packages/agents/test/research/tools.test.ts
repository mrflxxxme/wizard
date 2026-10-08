// V3-05: research tools for the models (zod → JSON Schema, snake_case, English descriptions, structured Russian
// errors) and the CI probe of .github/workflows/research.yml (≤ 3 searches, numbers and statuses only, masked
// secrets, recorded answers written as fixtures).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolFailure } from "../../src/core/index.js";
import { createResearch as createFromRoot, researchTools as toolsFromRoot } from "../../src/index.js";
import { PROBE_LIMITS, PROBE_QUERIES, runProbe } from "../../src/research/ci.js";
import {
  READ_PAGE_DEFAULT_CHARS,
  type RecordedExchange,
  recordedFetch,
  researchTools,
} from "../../src/research/index.js";
import { KEY_ENV, loadExchanges, recordedResearch, TEST_FOLDER, TEST_KEY } from "./helpers.js";

const byName = (tools: ReturnType<typeof researchTools>) => new Map(tools.map((t) => [t.name, t]));

async function run(
  tool: ReturnType<typeof researchTools>[number] | undefined,
  args: unknown,
): Promise<unknown> {
  if (!tool?.run) throw new Error("no tool");
  const parsed = tool.parse(args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return tool.run(parsed.value, { id: "c1", name: tool.name, args });
}

describe("research tools", () => {
  it("with the key: web_search, read_page, discover_docs — snake_case, English descriptions, JSON Schema", () => {
    const { research } = recordedResearch();
    const tools = researchTools(research);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "read_page", "discover_docs"]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description).toMatch(/^[\x20-\x7E—]+$/);
      expect(t.definition.parameters).toMatchObject({ type: "object" });
    }
    expect(byName(tools).get("web_search")?.description).toContain("At most 30 searches per build");
    expect(byName(tools).get("web_search")?.definition.parameters).toMatchObject({
      required: ["query"],
      properties: { query: { type: "string", maxLength: 400 } },
    });
  });

  it("without the key: no web_search; known addresses are read", async () => {
    const { research } = recordedResearch({ env: {} });
    const tools = byName(researchTools(research));
    expect([...tools.keys()]).toEqual(["read_page", "discover_docs"]);
    const page = (await run(tools.get("read_page"), {
      url: "https://klinika-kazan.example/blog/kak-vybrat",
    })) as {
      title: string;
    };
    expect(page.title).toContain("Как выбрать стоматологию");
  });

  it("web_search returns compact results; read_page slices markdown; discover_docs a filtered view", async () => {
    const { research } = recordedResearch();
    const tools = byName(researchTools(research));
    const s = (await run(tools.get("web_search"), { query: "стоматология Казань услуги" })) as {
      results: { title: string; url: string; snippet: string }[];
      remaining: number;
    };
    expect(s.results).toHaveLength(3);
    expect(Object.keys(s.results[0] ?? {})).toEqual(["title", "url", "snippet"]);
    expect(s.remaining).toBe(29);
    const p = (await run(tools.get("read_page"), {
      url: "https://klinika-kazan.example/blog/kak-vybrat",
      maxChars: 1000,
    })) as { markdown: string; truncated: boolean };
    expect(p.markdown.length).toBeLessThanOrEqual(1000);
    expect(READ_PAGE_DEFAULT_CHARS).toBe(8000);
    const d = (await run(tools.get("discover_docs"), {
      domain: "api.pay-docs.example",
      topic: "payments",
    })) as {
      openapi: { operations: unknown[] };
    };
    expect(d.openapi.operations.length).toBe(4);
  });

  it("refusals become structured tool errors with the code and a Russian message", async () => {
    const { research } = recordedResearch();
    const tools = byName(researchTools(research));
    const err = await run(tools.get("read_page"), { url: "http://169.254.169.254/latest/" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolFailure);
    expect(err).toMatchObject({ code: "EGRESS_PRIVATE" });
    expect((err as Error).message).toMatch(/внутреннюю сеть/);
  });

  it("is exported from the package root (append-only registration)", () => {
    const r = createFromRoot({ env: {} });
    expect(toolsFromRoot(r).map((t) => t.name)).toEqual(["read_page", "discover_docs"]);
  });
});

describe("CI probe (research.yml probe)", () => {
  it("≤ 3 searches of the fixed list and one page; prints numbers and statuses only; secrets masked everywhere", async () => {
    const template = loadExchanges().find((x) => x.key.startsWith("SEARCH стоматология")) as RecordedExchange;
    const article = loadExchanges().filter((x) => x.key.startsWith("GET https://klinika-kazan.example/"));
    // The answer echoes the folder id: the recording must not keep it.
    const exchanges: RecordedExchange[] = [
      ...PROBE_QUERIES.map((q) => ({
        ...template,
        key: `SEARCH ${q}|225|0`,
        body: template.body.replace("}", `,"echo":"${TEST_FOLDER}"}`),
      })),
      ...article,
      {
        key: "GET https://klinika-kazan.example/uslugi",
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><head><title>Услуги</title></head><body><main><p>Лечение и чистка.</p></main></body></html>",
      },
    ];
    let searches = 0;
    const lines: string[] = [];
    const out = mkdtempSync(join(tmpdir(), "research-probe-"));
    const res = await runProbe({
      env: KEY_ENV,
      out,
      fetch: recordedFetch(exchanges),
      searchFetch: recordedFetch(exchanges, () => {
        searches++;
      }),
      resolve: async () => ["93.184.215.14"],
      print: (l) => lines.push(l),
    });
    expect(res.code).toBe(0);
    expect(searches).toBe(3);
    expect(PROBE_LIMITS.searches).toBe(3);
    expect(res.costRub).toBeCloseTo(1.464, 3);
    expect(res.pages).toBe(1);
    expect(lines).toHaveLength(5);
    expect(
      lines
        .slice(0, 3)
        .every((l) =>
          /^::notice title=Поиск: проба::запрос \d: ok, результатов 3, всего 2400, \d+ мс$/.test(l),
        ),
    ).toBe(true);
    expect(lines[3]).toMatch(
      /^::notice title=Поиск: проба::страница: ok, \d+ символов markdown, \d+ байт, \d+ мс$/,
    );
    expect(lines[4]).toBe(
      "::notice title=Поиск: итог::поисков 3 (успешных 3), ≈ 1.46 ₽, страниц 1, ошибок 0",
    );
    const text =
      lines.join("\n") +
      readFileSync(join(out, "exchanges.json"), "utf8") +
      readFileSync(join(out, "summary.json"), "utf8");
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(TEST_FOLDER);
    for (const q of PROBE_QUERIES) expect(lines.join("\n")).not.toContain(q);
    const recorded = JSON.parse(readFileSync(join(out, "exchanges.json"), "utf8")) as RecordedExchange[];
    expect(recorded.filter((x) => x.key.startsWith("SEARCH "))).toHaveLength(3);
    expect(recorded.some((x) => x.key === "GET https://klinika-kazan.example/uslugi")).toBe(true);
    // The recording replays: fixtures for the next tests.
    const replay = createFromRoot({ env: KEY_ENV, mode: "fixture", fetch: recordedFetch(recorded) });
    expect((await replay.search(PROBE_QUERIES[0])).hits).toHaveLength(3);
  });

  it("a rejected key stops the probe after the first search", async () => {
    const exchanges = loadExchanges().map((x) =>
      x.key.startsWith("SEARCH ключ") ? { ...x, key: `SEARCH ${PROBE_QUERIES[0]}|225|0` } : x,
    );
    let searches = 0;
    const lines: string[] = [];
    const res = await runProbe({
      env: KEY_ENV,
      out: null,
      fetch: recordedFetch(exchanges),
      searchFetch: recordedFetch(exchanges, () => {
        searches++;
      }),
      resolve: async () => ["93.184.215.14"],
      print: (l) => lines.push(l),
    });
    expect(searches).toBe(1);
    expect(res.code).toBe(1);
    expect(res.costRub).toBe(0);
    expect(lines[0]).toBe("::warning title=Поиск: проба::запрос 1: SEARCH_AUTH");
  });

  it("without the secrets: an error line, no requests", async () => {
    const lines: string[] = [];
    const res = await runProbe({
      env: { YANDEX_FOLDER_ID: TEST_FOLDER },
      out: null,
      print: (l) => lines.push(l),
    });
    expect(res.code).toBe(1);
    expect(lines).toEqual(["::error title=Поиск: проба::нет секретов: YANDEX_SEARCH_API_KEY"]);
  });
});
