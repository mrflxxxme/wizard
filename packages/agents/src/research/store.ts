// Cache of research answers and the call journal. ResearchStore is the seam platform-api fills with its database later;
// values are JSON (what goes in is what comes out, never a live object).
import type { ResearchCall, ResearchLog } from "./types.js";

const HOUR = 3_600_000;

/**
 * How long answers live: search hits a day (they cost money); pages an hour — D46: loaded pages are kept no longer
 * than a run needs; documentation of a domain (llms.txt, OpenAPI, sitemap) a week; robots.txt a day (RFC 9309 §2.4).
 */
export const RESEARCH_TTL_MS = {
  search: 24 * HOUR,
  page: HOUR,
  docs: 7 * 24 * HOUR,
  robots: 24 * HOUR,
} as const;

/** Key–value cache with expiry; values must be JSON-serializable. */
export interface ResearchStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

/** In-memory ResearchStore: oldest entries go first beyond `maxEntries`. */
export class MemoryResearchStore implements ResearchStore {
  private readonly entries = new Map<string, { json: string; expires: number }>();
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(o: { maxEntries?: number; clock?: () => number } = {}) {
    this.maxEntries = o.maxEntries ?? 1000;
    this.clock = o.clock ?? Date.now;
  }

  async get(key: string): Promise<unknown | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expires <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return JSON.parse(e.json) as unknown;
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { json: JSON.stringify(value), expires: this.clock() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Journal kept in memory (tests, CI probe). */
export class MemoryResearchLog implements ResearchLog {
  readonly calls: ResearchCall[] = [];
  write(call: ResearchCall): void {
    this.calls.push(call);
  }
}
