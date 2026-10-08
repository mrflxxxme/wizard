// Research tools for the models (builder-v3.md §3 C8): web_search, read_page, discover_docs. Zod schemas become the
// JSON Schema of the model; a ResearchError becomes a structured tool error with a Russian message.
import { z } from "zod";
import type { AnyTool } from "../builder/tools.js";
import { defineTool, ToolFailure } from "../core/index.js";
import { docsView } from "./discover.js";
import type { Research } from "./research.js";
import { ResearchError } from "./types.js";

/** Markdown handed to the model per read_page call by default (the cache keeps up to PAGE_MAX_CHARS). */
export const READ_PAGE_DEFAULT_CHARS = 8000;

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ResearchError) throw new ToolFailure(e.code, e.message);
    throw e;
  }
}

/**
 * Research tools of a build: web_search only when search is available (key and folder set), read_page and
 * discover_docs always — without a key the agent reads known addresses only.
 */
export function researchTools(r: Research): AnyTool[] {
  const tools: AnyTool[] = [];
  if (r.status.search) {
    tools.push(
      defineTool({
        name: "web_search",
        description: `Web search (Yandex) for facts about the niche, competitors, prices and services in Russia. Personal data is removed from the query. At most ${r.limits.searches} searches per build; repeated queries are free.`,
        input: z.object({
          query: z.string().trim().min(2).max(400),
          region: z
            .string()
            .regex(/^\d{1,6}$/)
            .optional()
            .describe("Yandex region id: 225 Russia (default), 213 Moscow, 2 Saint Petersburg, 43 Kazan"),
          page: z.number().int().min(0).max(4).optional(),
        }),
        run: (a) =>
          guarded(async () => {
            const res = await r.search(a.query, {
              ...(a.region ? { region: a.region } : {}),
              ...(a.page !== undefined ? { page: a.page } : {}),
            });
            return {
              query: res.query,
              results: res.hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
              found: res.found,
              cached: res.cached,
              remaining: res.remaining,
            };
          }),
      }),
    );
  }
  tools.push(
    defineTool({
      name: "read_page",
      description:
        "Read a public web page (http/https) as clean markdown of its main content. robots.txt is respected; internal addresses are refused.",
      input: z.object({
        url: z.string().trim().min(8).max(2000),
        maxChars: z.number().int().min(1000).max(30_000).optional(),
      }),
      run: (a) =>
        guarded(async () => {
          const p = await r.readPage(a.url);
          const max = a.maxChars ?? READ_PAGE_DEFAULT_CHARS;
          return {
            url: p.finalUrl,
            title: p.title,
            markdown: p.markdown.slice(0, max),
            truncated: p.truncated || p.markdown.length > max,
            contentType: p.contentType,
            cached: p.cached,
          };
        }),
    }),
    defineTool({
      name: "discover_docs",
      description:
        "Find machine-readable docs of a site or API by domain: llms.txt, openapi.json/swagger.json, /.well-known/api-catalog, sitemap.xml. Optional topic filters links and operations.",
      input: z.object({
        domain: z.string().trim().min(3).max(300),
        topic: z.string().trim().max(200).optional(),
      }),
      run: (a) => guarded(async () => docsView(await r.discover(a.domain), a.topic)),
    }),
  );
  return tools;
}
