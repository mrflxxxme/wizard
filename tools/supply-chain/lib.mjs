// Dependency tree of the workspace for the license check and the CycloneDX SBOM (platform/deploy.yaml#cloud.ci_cd,
// L3-38). Source: `pnpm licenses list --json` (whole tree) and the same with --prod (what ships in images).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POLICY = JSON.parse(readFileSync(join(ROOT, "tools/supply-chain/policy.json"), "utf8"));

/** `pnpm licenses list --json [--prod]` → [{name, version, license, homepage}] (one entry per version). */
export function pnpmLicenses({ prod = false, cwd = ROOT } = {}) {
  const r = spawnSync("pnpm", ["licenses", "list", "--json", ...(prod ? ["--prod"] : [])], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`pnpm licenses list failed: ${r.stderr || r.stdout}`);
  return flattenLicenses(JSON.parse(r.stdout));
}

/** pnpm groups packages by license; flatten to one row per name@version. */
export function flattenLicenses(grouped) {
  const out = [];
  for (const [license, pkgs] of Object.entries(grouped)) {
    for (const p of pkgs) {
      for (const version of p.versions ?? [p.version]) {
        out.push({ name: p.name, version, license: p.license ?? license, homepage: p.homepage ?? null });
      }
    }
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)),
  );
}

/**
 * Minimal SPDX expression evaluation: ids, OR, AND, WITH (exception kept with its id), parentheses.
 * Returns true when some choice of OR branches has every id in `ok`.
 */
export function spdxSatisfies(expr, ok) {
  const tokens = String(expr ?? "")
    .replace(/[()]/g, (m) => ` ${m} `)
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  // or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := "(" or ")" | id ["WITH" id]
  function or() {
    let v = and();
    while (peek() && /^or$/i.test(peek())) {
      next();
      const r = and();
      v = v || r;
    }
    return v;
  }
  function and() {
    let v = atom();
    while (peek() && /^and$/i.test(peek())) {
      next();
      const r = atom();
      v = v && r;
    }
    return v;
  }
  function atom() {
    const t = next();
    if (t === undefined) throw new Error(`bad SPDX expression: ${expr}`);
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error(`bad SPDX expression: ${expr}`);
      return v;
    }
    if (peek() && /^with$/i.test(peek())) {
      next();
      next();
    }
    return ok(t.replace(/\+$/, ""));
  }
  if (tokens.length === 0) return false;
  const v = or();
  if (i !== tokens.length) throw new Error(`bad SPDX expression: ${expr}`);
  return v;
}

/**
 * Verdict of one package: allowed by policy (dev-only licenses only outside the prod tree), or an exception by name.
 * {ok, reason} — reason is "allowed" | "dev-only" | "exception" | "denied" | "unknown".
 */
export function verdict(pkg, { prod }, policy = POLICY) {
  if (Object.hasOwn(policy.exceptions ?? {}, pkg.name)) return { ok: true, reason: "exception" };
  const lic = pkg.license;
  if (!lic || /^(unknown|see license in|unlicensed)/i.test(lic)) return { ok: false, reason: "unknown" };
  const allowed = new Set(policy.allowed);
  const dev = new Set(policy.devOnly ?? []);
  let parsed;
  try {
    if (spdxSatisfies(lic, (id) => allowed.has(id))) return { ok: true, reason: "allowed" };
    parsed = spdxSatisfies(lic, (id) => allowed.has(id) || dev.has(id));
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (parsed && !prod) return { ok: true, reason: "dev-only" };
  return { ok: false, reason: "denied" };
}

/** Whole-tree check: prod set from --prod, the rest is dev. Returns {checked, violations[]}. */
export function checkTree(all, prodSet, policy = POLICY) {
  const prodKeys = new Set(prodSet.map((p) => `${p.name}@${p.version}`));
  const violations = [];
  for (const p of all) {
    const prod = prodKeys.has(`${p.name}@${p.version}`);
    const v = verdict(p, { prod }, policy);
    if (!v.ok) violations.push({ ...p, scope: prod ? "prod" : "dev", reason: v.reason });
  }
  return { checked: all.length, violations };
}

const purl = (name, version) =>
  `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${encodeURIComponent(version)}`;

/** CycloneDX 1.5 JSON BOM of the dependency tree; dev-only packages get scope "excluded". */
export function cyclonedx(all, prodSet, { name = "wizard", version = "0.0.0", serial, timestamp } = {}) {
  const prodKeys = new Set(prodSet.map((p) => `${p.name}@${p.version}`));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    ...(serial ? { serialNumber: serial } : {}),
    version: 1,
    metadata: {
      ...(timestamp ? { timestamp } : {}),
      tools: { components: [{ type: "application", name: "wizard-supply-chain", version: "1" }] },
      component: { type: "application", name, version, "bom-ref": `app:${name}` },
    },
    components: all.map((p) => {
      const ref = purl(p.name, p.version);
      const lic = p.license ?? "";
      const simple = /^[A-Za-z0-9.+-]+$/.test(lic);
      return {
        type: "library",
        "bom-ref": ref,
        name: p.name,
        version: String(p.version),
        purl: ref,
        scope: prodKeys.has(`${p.name}@${p.version}`) ? "required" : "excluded",
        ...(lic ? { licenses: simple ? [{ license: { id: lic } }] : [{ expression: lic }] } : {}),
        ...(p.homepage ? { externalReferences: [{ type: "website", url: p.homepage }] } : {}),
      };
    }),
  };
}
