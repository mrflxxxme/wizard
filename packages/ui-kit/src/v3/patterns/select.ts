// patternFor (builder-v3.md C3): deterministic choice of a variant with variety — by seed, without repeating the
// variants already used on the site and spreading layout families over the page (catalog L06).
import type { PatternMeta, PatternNeeds, SectionType } from "./types.js";

export interface PatternQuery {
  sectionType: SectionType;
  /** Archetype id of the design system (C2). */
  archetype: string;
  seed: number | string;
  /** Ids of the patterns already on the site, in page order. */
  used?: readonly string[];
  /**
   * The module logic the section binds (C4): only variants with these needs — a lead form is not a booking form, a
   * content section (null) has no hook. Absent — any variant of the type.
   */
  needs?: PatternNeeds;
}

/** FNV-1a 32-bit: stable across runs and platforms. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The pattern for a section among `patterns`: those that suit the archetype (else all of the type), not used yet
 * (else all suitable), with the least used layout family; ties broken by a hash of the seed. Null when the type has
 * no patterns yet (or none with the asked needs).
 */
export function selectPattern(patterns: readonly PatternMeta[], q: PatternQuery): PatternMeta | null {
  const ofType = patterns.filter(
    (p) => p.sectionType === q.sectionType && (q.needs === undefined || p.needs === q.needs),
  );
  if (ofType.length === 0) return null;
  const fits = ofType.filter((p) => p.archetypes.includes("*") || p.archetypes.includes(q.archetype));
  const pool = fits.length > 0 ? fits : ofType;
  const used = new Set(q.used ?? []);
  const fresh = pool.filter((p) => !used.has(p.id));
  const candidates = fresh.length > 0 ? fresh : pool;
  const layouts = new Map<string, number>();
  for (const p of patterns) if (used.has(p.id)) layouts.set(p.layout, (layouts.get(p.layout) ?? 0) + 1);
  const key = (p: PatternMeta) => hash32(`${q.seed}|${q.archetype}|${p.id}`);
  let best: PatternMeta | null = null;
  for (const p of candidates) {
    if (!best) {
      best = p;
      continue;
    }
    const a = layouts.get(p.layout) ?? 0;
    const b = layouts.get(best.layout) ?? 0;
    if (a < b || (a === b && key(p) < key(best))) best = p;
  }
  return best;
}
