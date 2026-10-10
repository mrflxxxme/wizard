#!/usr/bin/env node
// V3-40: the competitor's screenshots of the blind comparison (docs/ops/eval-pilot.md «Финальный замер v3», step 3)
// taken by a runner instead of by hand: the founder sends the public addresses of the competitor's sites built on the
// same briefs, this script opens each in Chromium and saves the first screen at the widths of the Wizard shots
// (390×844 and 1440×900, PNG like Wizard's — the raters must not tell the source by the file) with meta.json.
//   node tools/eval/blind/shoot.mjs --urls "v3-01=https://…;v3-02=https://…" --service "Tilda AI" --out competitor
//   → competitor/<brief id>/390.png, 1440.png, meta.json {service, url}
// Only public https addresses (no IP literals, no localhost or internal names); a page that does not open is a
// warning and the brief stays without the competitor's site.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickBriefs } from "./cli.mjs";

/** The widths of the comparison (tools/eval/server/screenshots.mjs V3_FINAL_VIEWPORTS). */
export const SHOOT_VIEWPORTS = [
  { suffix: "390", width: 390, height: 844 },
  { suffix: "1440", width: 1440, height: 900 },
];
/** How long a page may take to load, then how long its first screen settles (fonts, images, entrance motion). */
export const SHOOT_TIMEOUT_MS = 45_000;
export const SHOOT_SETTLE_MS = 2_500;

/** A public https address or null: no credentials, no IP literal, no single-label or internal host. */
export function publicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|svc|cluster)$/.test(host)) return null;
  return u.toString();
}

/**
 * «v3-01=https://…;v3-02=https://…» (also «,» or new lines between pairs) → [{brief, url}] with the full brief ids of
 * the final set; unknown briefs and addresses that are not public https throw with the reason in Russian.
 */
export function parseUrls(text, briefs = pickBriefs("all")) {
  const out = [];
  for (const part of String(text ?? "")
    .split(/[;\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`ожидается «бриф=адрес»: ${part}`);
    const id = part.slice(0, eq).trim();
    const brief = briefs.find((b) => b.id === id || b.id.startsWith(`${id}-`));
    if (!brief) throw new Error(`неизвестный бриф: ${id}`);
    const url = publicUrl(part.slice(eq + 1));
    if (!url) throw new Error(`адрес брифа ${id} — не публичный https`);
    if (out.some((x) => x.brief === brief.id)) throw new Error(`бриф ${id} указан дважды`);
    out.push({ brief: brief.id, url });
  }
  if (out.length === 0) throw new Error("нет ни одного адреса");
  return out;
}

/** Shoots every site at every width; → {shot: [brief], failed: [{brief, error}]}. `launch` → a Playwright browser. */
export async function shootSites({ sites, service, out, launch, log = () => {} }) {
  const shot = [];
  const failed = [];
  const browser = await launch();
  try {
    for (const s of sites) {
      const dir = join(out, s.brief);
      try {
        mkdirSync(dir, { recursive: true });
        for (const vp of SHOOT_VIEWPORTS) {
          const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, locale: "ru-RU" });
          try {
            await page.goto(s.url, { waitUntil: "load", timeout: SHOOT_TIMEOUT_MS });
            await page.waitForTimeout(SHOOT_SETTLE_MS);
            await page.screenshot({ path: join(dir, `${vp.suffix}.png`), type: "png" });
          } finally {
            await page.close().catch(() => {});
          }
        }
        writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ service, url: s.url }, null, 2)}\n`);
        shot.push(s.brief);
        log(`✓ ${s.brief}`);
      } catch (e) {
        failed.push({ brief: s.brief, error: String(e?.message ?? e).split("\n")[0].slice(0, 200) });
        log(`✗ ${s.brief}: ${failed.at(-1).error}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { shot, failed };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1] ?? "";
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? undefined : eq.slice(name.length + 3);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? ((s) => console.error(s));
  const service = (arg(argv, "service") ?? "").trim();
  if (!service) throw new Error("нужен --service: сервис конкурента, например Tilda AI");
  const sites = parseUrls(arg(argv, "urls"));
  const out = arg(argv, "out") || "competitor";
  const launch =
    deps.launch ?? (await import("../server/screenshots.mjs").then((m) => () => m.launchChromium()));
  const r = await shootSites({ sites, service, out, launch, log });
  log(`снято ${r.shot.length} из ${sites.length}${r.failed.length ? `; не открылись: ${r.failed.map((f) => f.brief).join(", ")}` : ""}`);
  return r.shot.length > 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
