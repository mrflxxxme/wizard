// Seeded randomness of the art director: the same seed and key give the same stream on every machine (no Math.random).
// Each aspect draws from its own stream (`rng(seed, "fonts")`), so a new aspect never shifts the others.

/** 32-bit FNV-1a of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stream of numbers in [0, 1) for a seed and key (mulberry32). */
export function rng(seed: string | number, key: string): () => number {
  let a = hash32(`${seed}|${key}`);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One element of a non-empty list. */
export function pick<T>(list: readonly T[], r: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(r() * list.length))] as T;
}

/** A number in [lo, hi]. */
export const within = (range: readonly [number, number], r: () => number): number =>
  range[0] + (range[1] - range[0]) * r();
