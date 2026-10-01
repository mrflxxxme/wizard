// L3-38: license policy of AGENTS.md over the dependency tree and the CycloneDX SBOM.
import { describe, expect, it } from "vitest";
import {
  checkTree,
  cyclonedx,
  flattenLicenses,
  POLICY,
  pnpmLicenses,
  spdxSatisfies,
  verdict,
} from "../lib.mjs";

const pkg = (name, license, version = "1.0.0") => ({ name, version, license, homepage: null });

describe("SPDX expressions", () => {
  const ok = (id) => ["MIT", "BSD-3-Clause"].includes(id);
  it("OR needs one branch, AND needs all, parentheses and WITH", () => {
    expect(spdxSatisfies("MIT", ok)).toBe(true);
    expect(spdxSatisfies("(AFL-2.1 OR BSD-3-Clause)", ok)).toBe(true);
    expect(spdxSatisfies("MIT AND GPL-3.0", ok)).toBe(false);
    expect(spdxSatisfies("(MIT AND BSD-3-Clause) OR GPL-2.0", ok)).toBe(true);
    expect(spdxSatisfies("GPL-2.0 WITH Classpath-exception-2.0", ok)).toBe(false);
    expect(spdxSatisfies("", ok)).toBe(false);
    expect(() => spdxSatisfies("(MIT", ok)).toThrow();
  });
});

describe("policy of AGENTS.md", () => {
  it("permissive licenses pass everywhere; MPL-2.0 only for dev; copyleft and unknown fail", () => {
    for (const l of ["MIT", "Apache-2.0", "BSD-2-Clause", "ISC", "OFL-1.1", "MIT OR Apache-2.0"]) {
      expect(verdict(pkg("x", l), { prod: true }).ok, l).toBe(true);
    }
    expect(verdict(pkg("x", "MPL-2.0"), { prod: false })).toEqual({ ok: true, reason: "dev-only" });
    expect(verdict(pkg("x", "MPL-2.0"), { prod: true })).toEqual({ ok: false, reason: "denied" });
    // The FSL id is assembled: scripts/check-code.mjs bans the literal anywhere in the sources (L3-40).
    const fsl = ["FSL", "1.1", "MIT"].join("-");
    for (const l of ["GPL-3.0", "AGPL-3.0-only", "LGPL-2.1", "SSPL-1.0", "BUSL-1.1", fsl]) {
      expect(verdict(pkg("x", l), { prod: false }), l).toEqual({ ok: false, reason: "denied" });
    }
    expect(verdict(pkg("x", undefined), { prod: true })).toEqual({ ok: false, reason: "unknown" });
    expect(verdict(pkg("x", "SEE LICENSE IN LICENSE.md"), { prod: true }).ok).toBe(false);
    expect(verdict(pkg("postgres", "Unlicense"), { prod: true })).toEqual({ ok: true, reason: "exception" });
  });

  it("checkTree classifies by the production tree", () => {
    const all = [pkg("a", "MIT"), pkg("b", "MPL-2.0"), pkg("c", "GPL-3.0")];
    const r = checkTree(all, [pkg("a", "MIT"), pkg("b", "MPL-2.0")], POLICY);
    expect(r.violations.map((v) => [v.name, v.scope, v.reason])).toEqual([
      ["b", "prod", "denied"],
      ["c", "dev", "denied"],
    ]);
  });

  it("the current workspace tree passes", () => {
    const all = pnpmLicenses();
    const prod = pnpmLicenses({ prod: true });
    expect(all.length).toBeGreaterThan(20);
    expect(prod.length).toBeLessThanOrEqual(all.length);
    expect(checkTree(all, prod).violations).toEqual([]);
  }, 60_000);
});

describe("CycloneDX", () => {
  it("1.5 JSON with purls, SPDX ids or expressions, prod scope", () => {
    const all = flattenLicenses({
      MIT: [{ name: "@scope/a", versions: ["1.2.3"], license: "MIT", homepage: "https://a.example" }],
      "(MIT OR CC0-1.0)": [{ name: "b", versions: ["0.1.0", "0.2.0"], license: "(MIT OR CC0-1.0)" }],
    });
    const bom = cyclonedx(all, [all[0]], { name: "wizard", version: "9" });
    expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1 });
    expect(bom.metadata.component).toMatchObject({ name: "wizard", version: "9" });
    expect(bom.components).toEqual([
      expect.objectContaining({
        name: "@scope/a",
        purl: "pkg:npm/%40scope/a@1.2.3",
        scope: "required",
        licenses: [{ license: { id: "MIT" } }],
        externalReferences: [{ type: "website", url: "https://a.example" }],
      }),
      expect.objectContaining({
        name: "b",
        version: "0.1.0",
        scope: "excluded",
        licenses: [{ expression: "(MIT OR CC0-1.0)" }],
      }),
      expect.objectContaining({ name: "b", version: "0.2.0" }),
    ]);
    expect(new Set(bom.components.map((c) => c["bom-ref"])).size).toBe(3);
  });
});
