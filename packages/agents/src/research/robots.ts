// robots.txt by RFC 9309: groups by product token (else "*"), the longest matching rule wins, Allow wins a tie;
// `*` and a trailing `$` in patterns. Fetch outcome: 2xx → rules, 4xx → everything allowed, 5xx or unreachable →
// everything disallowed.
import { RESEARCH_BOT } from "./net.js";

/** Rules of one site for the research bot. */
export interface Robots {
  /** `path` with its query string, as in the request line. */
  allows(path: string): boolean;
  /** Sitemap: lines (absolute URLs). */
  sitemaps: string[];
}

interface Rule {
  allow: boolean;
  length: number;
  re: RegExp;
}

/** Max robots.txt size read (RFC 9309 §2.5: at least 500 KiB). */
export const ROBOTS_MAX_BYTES = 512 * 1024;

export const ALLOW_ALL: Robots = { allows: () => true, sitemaps: [] };
export const DISALLOW_ALL: Robots = { allows: (p) => p === "/robots.txt", sitemaps: [] };

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Parses robots.txt for the product token `agent` (default WizardResearchBot). */
export function parseRobots(text: string, agent: string = RESEARCH_BOT): Robots {
  const token = agent.toLowerCase();
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let inAgents = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "sitemap") {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!inAgents || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase().split("/")[0]?.trim() ?? "");
      inAgents = true;
      continue;
    }
    if ((key === "allow" || key === "disallow") && current !== null) {
      inAgents = false;
      if (value === "") continue;
      current.rules.push({ allow: key === "allow", length: value.length, re: toRegExp(value) });
    }
  }
  const own = groups.filter((g) => g.agents.includes(token));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  return {
    sitemaps,
    allows(path: string): boolean {
      if (path === "/robots.txt") return true;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (best === null || r.length > best.length || (r.length === best.length && r.allow)) best = r;
      }
      return best === null || best.allow;
    },
  };
}

/** Robots of a fetch outcome: status of /robots.txt (null when unreachable) and its text. */
export function robotsFromStatus(status: number | null, text: string): Robots {
  if (status === null || status >= 500) return DISALLOW_ALL;
  if (status >= 400) return ALLOW_ALL;
  return parseRobots(text);
}
