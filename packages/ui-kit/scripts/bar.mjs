// Builds the bar preview (grill-11 (2)): Tailwind through @wizard/build compileTailwind, the client through esbuild,
// stock photos and fonts inlined. Writes index.html (both sites with a switch) and one page per site, then shoots
// 1440 and 390 px snapshots with Playwright. Usage: node scripts/bar.mjs <out-dir> [--no-shots] [--heroes]
// [--blocks <dir>]: --blocks shoots every library block (V5-01) of the two sites at 390 and 1440 px into <dir>.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "demo/dist/bar"));
const esbuild = createRequire(createRequire(join(root, "package.json")).resolve("vite"))("esbuild");
mkdirSync(join(out, "photos"), { recursive: true });

// Node side: CSS, fonts, photo list.
// Each half sits next to its package, so its external dependencies (tailwindcss, zod…) resolve from there.
async function nodeModule(pkg, contents) {
  const outfile = join(root, "..", pkg, "node_modules/.cache/bar-entry.mjs");
  await esbuild.build({
    stdin: { contents, resolveDir: join(root, "..", pkg), loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile,
    logLevel: "warning",
  });
  return import(pathToFileURL(outfile).href);
}
const N = {
  ...(await nodeModule(
    "ui-kit",
    `export { barDesignCss, BAR_FONTS } from "./src/v3/bar/css.ts";
export { BAR_PHOTOS } from "./src/v3/bar/photos.ts";
export { fontFaceCss } from "./src/tokens/fonts.ts";`,
  )),
  ...(await nodeModule("build", `export { compileTailwind, tailwindCandidates } from "./src/tailwind.ts";`)),
};

const barDir = join(root, "src/v3/bar");
const sources = [];
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f.name))
      sources.push([`ui/sections/${p.slice(root.length + 1)}`, readFileSync(p, "utf8")]);
  }
};
walk(barDir);
walk(join(root, "src/v4/blocks"));
const tw = await N.compileTailwind(N.barDesignCss(), N.tailwindCandidates(sources));
if (!tw.ok) throw new Error(tw.error);
const fontDir = join(root, "fonts");
const fonts = N.fontFaceCss(N.BAR_FONTS, "FONT:").replace(
  /url\(FONT:([^)]+)\)/g,
  (_, f) => `url(data:font/woff2;base64,${readFileSync(join(fontDir, f)).toString("base64")})`,
);
const css = `${fonts}\n${tw.css}`;

// Photos: stock copies at 1400 px, credited (D61).
const photos = {};
for (const [slot, p] of Object.entries(N.BAR_PHOTOS)) {
  const file = join(out, "photos", p.file);
  if (!existsSync(file)) execFileSync("curl", ["-sSfL", "-o", file, `${p.cdnUrl}&w=1400`]);
  photos[slot] = {
    src: `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`,
    alt: p.alt,
    credit: `${p.author} / Pexels`,
  };
}

const client = await esbuild.build({
  entryPoints: [join(barDir, "client.tsx")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
  logLevel: "warning",
});
const js = client.outputFiles[0].text;

const page = (title, data) => `<!doctype html>
<html lang="ru" data-site="${data.sites[0]}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}
html,body{margin:0;background:var(--color-background)}</style></head>
<body><div id="bar-root"></div>
<script>window.__BAR__=${JSON.stringify({ ...data, photos })}</script>
<script type="module">${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

writeFileSync(
  join(out, "index.html"),
  page("Планка двух сайтов", { sites: ["bakery", "service"], switcher: true }),
);
writeFileSync(
  join(out, "bakery.html"),
  page("Булочная Терехова", { sites: ["bakery"], switcher: false, now: "09:40" }),
);
writeFileSync(join(out, "service.html"), page("Бокс 14", { sites: ["service"], switcher: false }));
// Grill-11 round 4: the sites П5 and С5 with a switch, and a switch-less copy for the snapshots.
const HERO_IDS = ["b5", "s5"];
writeFileSync(
  join(out, "heroes.html"),
  page("Сайты П5 и С5", { sites: ["bakery"], switcher: true, view: "heroes" }),
);
writeFileSync(
  join(out, "heroes-shot.html"),
  page("Сайты П5 и С5", { sites: ["bakery"], switcher: false, view: "heroes" }),
);
console.log(
  `html: ${out} (index ${(readFileSync(join(out, "index.html")).length / 1e6).toFixed(1)} MB, js ${(js.length / 1024).toFixed(0)} KB)`,
);

const blocksAt = process.argv.indexOf("--blocks");
if (blocksAt > 0) {
  const dir = resolve(process.argv[blocksAt + 1]);
  mkdirSync(dir, { recursive: true });
  // Sections of the round-4 sites in page order: each is one block of the catalog (the header sits in the hero).
  const ORDER = {
    s5: ["hero", "prices", "booking", "status", "steps", "reviews", "contacts", "footer"],
    b5: ["hero", "menu", "moment", "order", "locations", "reviews", "footer"],
  };
  const DIR = { b5: "masterskaya", s5: "nochnoy-produkt" };
  const pw = await import(
    pathToFileURL(createRequire(join(root, "package.json")).resolve("@playwright/test")).href
  );
  const browser = await (pw.chromium ?? pw.default.chromium).launch();
  for (const id of HERO_IDS)
    for (const [w, h] of [
      [1440, 900],
      [390, 844],
    ]) {
      const pg = await browser.newPage({ viewport: { width: w, height: h } });
      await pg.goto(`${pathToFileURL(join(out, "heroes-shot.html")).href}#${id}`);
      await pg.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      });
      const site = pg.locator("#bar-root > div > div");
      const parts = [
        ["header", site.locator("header").first()],
        ...ORDER[id].map((name, i) => [name, site.locator(":scope > *").nth(i)]),
      ];
      for (const [name, loc] of parts) {
        await loc.scrollIntoViewIfNeeded();
        // The signature blocks play once in view (status ≈ 3 s); the rest settle at once.
        await pg.waitForTimeout(["status", "moment", "hero"].includes(name) ? 4000 : 400);
        await loc.screenshot({ path: join(dir, `${DIR[id]}.${name}-${w}.jpg`), type: "jpeg", quality: 70 });
      }
      await pg.close();
    }
  await browser.close();
  console.log(`blocks: ${dir}`);
}

if (!process.argv.includes("--no-shots")) {
  const pw = await import(
    pathToFileURL(createRequire(join(root, "package.json")).resolve("@playwright/test")).href
  );
  const chromium = pw.chromium ?? pw.default.chromium;
  const browser = await chromium.launch();
  const targets = process.argv.includes("--heroes")
    ? HERO_IDS.map((id) => [id, `heroes-shot.html#${id}`])
    : ["bakery", "service"].map((s) => [s, `${s}.html`]);
  for (const [site, file] of targets)
    for (const [w, h] of [
      [1440, 900],
      [390, 844],
    ]) {
      const pg = await browser.newPage({ viewport: { width: w, height: h } });
      await pg.goto(
        pathToFileURL(join(out, file.split("#")[0])).href +
          (file.includes("#") ? `#${file.split("#")[1]}` : ""),
      );
      await pg.evaluate(async () => {
        await document.fonts.ready;
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
        await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      });
      await pg.waitForTimeout(2500);
      await pg.screenshot({ path: join(out, `${site}-${w}.png`), fullPage: true });
      await pg.close();
    }
  await browser.close();
  console.log("shots: done");
}
