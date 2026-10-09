// Facts about the niche the interview finds itself (grill-8 № 8; C8 research of V3-05): web_search and read_page over
// the build's Research with the interview's own limits (INTERVIEW_RESEARCH_LIMITS per interview, counted in the
// session), trimmed results for the prompt. Without a search key only read_page is offered (known addresses).
import { z } from "zod";
import type { AnyTool } from "../builder/tools.js";
import { defineTool, ToolFailure } from "../core/tool.js";
import { clip } from "../planner/tolerant.js";
import type { Research } from "../research/research.js";
import { ResearchError } from "../research/types.js";
import { INTERVIEW_RESEARCH_LIMITS, type InterviewV3Session } from "./schemas.js";

/** Search hits and page characters handed to the interview model per call. */
export const INTERVIEW_SEARCH_HITS = 5;
export const INTERVIEW_PAGE_CHARS = 3000;

function asFailure(e: unknown): never {
  if (e instanceof ResearchError) throw new ToolFailure(e.code, e.message);
  throw e;
}

/**
 * The research tools of one interview turn: each call checks the session's count first (a refusal costs nothing);
 * answered and failed calls count, repeated (cached) searches do not.
 */
export function interviewResearchTools(
  research: Research | null | undefined,
  s: InterviewV3Session,
): AnyTool[] {
  if (!research) return [];
  const L = INTERVIEW_RESEARCH_LIMITS;
  const tools: AnyTool[] = [];
  if (research.status.search && s.research.searches < L.searches)
    tools.push(
      defineTool({
        name: "web_search",
        description: `Web search (Yandex) for facts about the niche in Russia: typical services, how the work goes, legal requirements. At most ${L.searches} searches per interview; personal data is removed from the query.`,
        input: z.object({ query: z.string().trim().min(2).max(200) }),
        run: async (a) => {
          if (s.research.searches >= L.searches)
            throw new ToolFailure("RESEARCH_LIMIT", `Лимит поиска на интервью исчерпан (${L.searches}).`);
          try {
            const r = await research.search(a.query);
            if (!r.cached) s.research.searches += 1;
            return {
              query: r.query,
              results: r.hits
                .slice(0, INTERVIEW_SEARCH_HITS)
                .map((h) => ({ title: h.title, url: h.url, snippet: clip(h.snippet, 300) })),
              left: Math.max(0, L.searches - s.research.searches),
            };
          } catch (e) {
            s.research.searches += 1;
            return asFailure(e);
          }
        },
      }),
    );
  if (s.research.pages < L.pages)
    tools.push(
      defineTool({
        name: "read_page",
        description: `Read a public web page as clean text (at most ${L.pages} pages per interview).`,
        input: z.object({ url: z.string().trim().min(8).max(2000) }),
        run: async (a) => {
          if (s.research.pages >= L.pages)
            throw new ToolFailure(
              "RESEARCH_LIMIT",
              `Лимит чтения страниц на интервью исчерпан (${L.pages}).`,
            );
          try {
            const p = await research.readPage(a.url);
            if (!p.cached) s.research.pages += 1;
            return {
              url: p.finalUrl,
              title: p.title,
              text: p.markdown.slice(0, INTERVIEW_PAGE_CHARS),
              truncated: p.truncated || p.markdown.length > INTERVIEW_PAGE_CHARS,
            };
          } catch (e) {
            s.research.pages += 1;
            return asFailure(e);
          }
        },
      }),
    );
  return tools;
}
