// V3-40: the blind comparison of the final v3 measurement (docs/plans/2026-10-08-v3.md §6 (2)–(3)). The sites of
// Wizard (screenshots of the final run, tools/eval/server/screenshots.mjs V3_FINAL_VIEWPORTS: <brief>-390.png,
// <brief>-1440.png) and of a competitor for the same briefs (filled in by a person: competitor/<brief>/{390,1440}.jpg
// and meta.json {service, url?}) are laid out in pairs for the raters: Wizard–competitor for each brief, and inside
// each class Wizard–Wizard and competitor–competitor (so every site shows up as often as any other and the «one
// template» question is asked of both sides). The order and the sides A/B come from a fixed seed; the page knows
// neither the sources nor the brief ids — those stay in the key, which never goes to the raters.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

/** Viewports of a pair: the phone, then the desktop (the widths of the template gate). */
export const BLIND_VIEWPORTS = [
  { id: "390", label: "Телефон, 390 px" },
  { id: "1440", label: "Компьютер, 1440 px" },
];
/** Pair kinds: wc — Wizard–competitor (counts for «Wizard wins»), ww / cc — two sites of one class of one source. */
export const PAIR_KINDS = ["wc", "ww", "cc"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

/** A deterministic PRNG of a seed string: mulberry32 over the first 32 bits of sha256(seed), values in [0, 1). */
export function seededRandom(seed) {
  let a = Number.parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy. */
export function shuffle(xs, rand) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const imageIn = (dir, stem) => {
  for (const ext of IMAGE_EXT) {
    const p = join(dir, `${stem}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
};

/**
 * The sites of the comparison from the folders: `briefs` (loadBriefs("v3-final") or a part), `wizardDir` — the shots/
 * folder of the run's artifact, `competitorDir` — competitor/<brief id or its short form v3-02>/{390,1440}.<png|jpg>
 * with meta.json {service, url?}. → {sites: [{source, briefId, class, title, service, images: {390, 1440}}], warnings}.
 */
export function collectSites({ briefs, wizardDir, competitorDir }) {
  const sites = [];
  const warnings = [];
  for (const b of briefs) {
    const short = b.id.split("-").slice(0, 2).join("-");
    if (wizardDir) {
      const w390 = imageIn(wizardDir, `${b.id}-390`);
      let w1440 = imageIn(wizardDir, `${b.id}-1440`);
      if (!w1440 && (w1440 = imageIn(wizardDir, `${b.id}-1280`)))
        warnings.push(`${b.id}: у Wizard снимок компьютера 1280 px, а не 1440 px`);
      if (w390 && w1440)
        sites.push({
          source: "wizard",
          briefId: b.id,
          class: b.class,
          title: b.title,
          service: "Wizard",
          images: { 390: w390, 1440: w1440 },
        });
      else warnings.push(`${b.id}: нет снимков Wizard (${b.id}-390.png и ${b.id}-1440.png)`);
    }
    if (competitorDir) {
      const dir = [join(competitorDir, b.id), join(competitorDir, short)].find((d) => existsSync(d));
      const c390 = dir ? imageIn(dir, "390") : null;
      const c1440 = dir ? imageIn(dir, "1440") : null;
      if (c390 && c1440) {
        let meta = {};
        try {
          meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        } catch {
          warnings.push(`${b.id}: нет meta.json конкурента — сервис не назван`);
        }
        sites.push({
          source: "competitor",
          briefId: b.id,
          class: b.class,
          title: b.title,
          service: typeof meta.service === "string" && meta.service.trim() ? meta.service.trim() : "конкурент",
          ...(typeof meta.url === "string" ? { url: meta.url } : {}),
          images: { 390: c390, 1440: c1440 },
        });
      } else warnings.push(`${b.id}: нет снимков конкурента (competitor/${b.id}/390.jpg и 1440.jpg)`);
    }
  }
  const exts = (source) =>
    new Set(
      sites
        .filter((s) => s.source === source)
        .flatMap((s) => Object.values(s.images).map((p) => extname(p).toLowerCase().replace("jpeg", "jpg"))),
    );
  const [we, ce] = [exts("wizard"), exts("competitor")];
  if (we.size && ce.size && [...we].join() !== [...ce].join())
    warnings.push(
      `форматы снимков разные (Wizard: ${[...we].join(", ")}; конкурент: ${[...ce].join(", ")}) — по расширению файла можно угадать источник; сохраните снимки конкурента в том же формате`,
    );
  return { sites, warnings };
}

const siteKey = (s) => `${s.source}:${s.briefId}`;

/** Every pair of the comparison in a canonical order (independent of the input order). */
function pairSpecs(sites, controls) {
  const by = new Map(sites.map((s) => [siteKey(s), s]));
  const sorted = [...by.values()].sort((a, b) => siteKey(a).localeCompare(siteKey(b)));
  const specs = [];
  for (const w of sorted.filter((s) => s.source === "wizard")) {
    const c = by.get(`competitor:${w.briefId}`);
    if (c) specs.push({ kind: "wc", class: w.class, sites: [w, c] });
  }
  for (const [kind, source] of [
    ["ww", "wizard"],
    ["cc", "competitor"],
  ]) {
    if (kind === "cc" && !controls) continue;
    const own = sorted.filter((s) => s.source === source);
    for (let i = 0; i < own.length; i++)
      for (let j = i + 1; j < own.length; j++)
        if (own[i].class === own[j].class) specs.push({ kind, class: own[i].class, sites: [own[i], own[j]] });
  }
  return specs;
}

/**
 * The layout of the page: pairs in the order of `seed`, each with its sides A/B drawn by the same PRNG.
 * → {layoutId, seed, pairs (for the page: {id, A: {title, images}, B}), key (for aggregate.mjs: the sources), files
 * ([{from, name}] — the images under neutral names img/<hash><ext>)}. `controls` false drops the cc pairs.
 */
export function blindLayout({ sites, seed, controls = true }) {
  if (!seed) throw new Error("нужен seed: порядок пар фиксируется им");
  const specs = pairSpecs(sites, controls);
  const layoutId = sha(
    JSON.stringify([String(seed), specs.map((s) => [s.kind, ...s.sites.map(siteKey)])]),
  ).slice(0, 12);
  const rand = seededRandom(`${seed}:${layoutId}`);
  const order = shuffle(specs, rand);
  const pairs = [];
  const keyPairs = [];
  const files = [];
  order.forEach((s, i) => {
    const id = `p${String(i + 1).padStart(2, "0")}`;
    const [first, second] = rand() < 0.5 ? s.sites : [s.sites[1], s.sites[0]];
    const side = (site, letter) => {
      const images = {};
      for (const v of BLIND_VIEWPORTS) {
        const from = site.images[v.id];
        const name = `img/${sha(`${layoutId}:${id}:${letter}:${v.id}`).slice(0, 16)}${extname(from).toLowerCase()}`;
        files.push({ from, name });
        images[v.id] = name;
      }
      return { title: site.title, images };
    };
    pairs.push({ id, A: side(first, "A"), B: side(second, "B") });
    const k = (site) => ({
      source: site.source,
      briefId: site.briefId,
      service: site.service,
      ...(site.url ? { url: site.url } : {}),
    });
    keyPairs.push({ id, kind: s.kind, class: s.class, A: k(first), B: k(second) });
  });
  return {
    layoutId,
    seed: String(seed),
    pairs,
    key: { kind: "wizard-blind-key", version: 1, layoutId, seed: String(seed), pairs: keyPairs },
    files,
  };
}

/** Folders the CLI reads votes from: every *.json of a folder (or the files given). */
export function voteFiles(paths) {
  const out = [];
  for (const p of paths) {
    if (existsSync(p) && !p.endsWith(".json"))
      for (const f of readdirSync(p).filter((x) => x.endsWith(".json")).sort()) out.push(join(p, f));
    else out.push(p);
  }
  return out;
}
