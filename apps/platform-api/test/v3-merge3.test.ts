// V3-32 (the V3-31 leftover «построчное слияние»): a three-way line merge of a file both Wizard and the client's
// developers changed. Safe by construction — apart hunks merge, overlapping or touching ones conflict — and checked
// against `git merge-file` as the oracle on generated edits: whenever we merge, git merges to the same text.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { merge3 } from "../src/git/merge3.js";
import { HAS_GIT } from "./git-sync/git-http.js";

const lines = (n: number, tag = "строка") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`);
const text = (xs: readonly string[]) => xs.join("");

describe("merge3", () => {
  const base = lines(12);

  test("edits far apart merge; each side's hunk is taken", () => {
    const ours = [...base];
    ours[1] = "Wizard: заголовок\n";
    const theirs = [...base];
    theirs[9] = "разработчик: подвал\n";
    theirs.push("разработчик: новая строка\n");
    const r = merge3(text(base), text(ours), text(theirs));
    expect(r).toMatchObject({ ok: true, ours: 1, theirs: 2 });
    if (!r.ok) return;
    const out = r.text.split("\n");
    expect(out[1]).toBe("Wizard: заголовок");
    expect(out[9]).toBe("разработчик: подвал");
    expect(out[12]).toBe("разработчик: новая строка");
  });

  test("the same change on both sides is taken once", () => {
    const both = [...base];
    both[4] = "одинаково\n";
    const r = merge3(text(base), text(both), text(both));
    expect(r).toEqual({ ok: true, text: text(both), ours: 0, theirs: 0 });
    const ours = [...both];
    ours[0] = "только Wizard\n";
    const r2 = merge3(text(base), text(ours), text(both));
    expect(r2.ok && r2.text).toBe(text([ours[0] as string, ...both.slice(1)]));
  });

  test("overlapping and adjacent edits conflict with the base range named", () => {
    const ours = [...base];
    ours[5] = "Wizard\n";
    const theirs = [...base];
    theirs[5] = "разработчик\n";
    expect(merge3(text(base), text(ours), text(theirs))).toEqual({
      ok: false,
      conflicts: [{ from: 6, to: 6 }],
    });
    // Adjacent lines: no unchanged line between the hunks — a conflict, as in git.
    const t2 = [...base];
    t2[6] = "разработчик\n";
    expect(merge3(text(base), text(ours), text(t2)).ok).toBe(false);
    // An insertion right at the other side's change.
    const t3 = [...base.slice(0, 5), "вставка\n", ...base.slice(5)];
    expect(merge3(text(base), text(ours), text(t3)).ok).toBe(false);
  });

  test("a deleted region against an edit inside it conflicts; a missing newline at the end is kept", () => {
    const ours = [...base.slice(0, 3), ...base.slice(8)];
    const theirs = [...base];
    theirs[5] = "правка внутри удалённого\n";
    expect(merge3(text(base), text(ours), text(theirs)).ok).toBe(false);
    const b = "a\nb\nc\nd\ne";
    const r = merge3(b, "A\nb\nc\nd\ne", "a\nb\nc\nd\nE");
    expect(r.ok && r.text).toBe("A\nb\nc\nd\nE");
  });
});

describe.skipIf(!HAS_GIT)("merge3 against git merge-file (oracle)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wz-merge3-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Deterministic pseudo-random edits of a base (seeded LCG). */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  function edit(base: readonly string[], rnd: () => number, tag: string): string[] {
    const out = [...base];
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const at = Math.floor(rnd() * out.length);
      const kind = rnd();
      if (kind < 0.4) out[at] = `${tag} правка ${k}\n`;
      else if (kind < 0.7) out.splice(at, 0, `${tag} вставка ${k}\n`);
      else if (out.length > 1) out.splice(at, 1);
    }
    return out;
  }

  test("200 generated pairs: every merge we make, git makes the same; we never merge what git calls a conflict", () => {
    let merged = 0;
    let conflicted = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = rng(seed);
      const base = lines(8 + Math.floor(rnd() * 20));
      const ours = edit(base, rnd, "W");
      const theirs = edit(base, rnd, "D");
      const [b, o, t] = ["base", "ours", "theirs"].map((n) => join(dir, `${seed}.${n}`)) as [
        string,
        string,
        string,
      ];
      writeFileSync(b, text(base));
      writeFileSync(o, text(ours));
      writeFileSync(t, text(theirs));
      const g = spawnSync("git", ["merge-file", "-q", o, b, t], { encoding: "utf8" });
      const gitOk = g.status === 0;
      const r = merge3(text(base), text(ours), text(theirs));
      if (r.ok) {
        expect(gitOk, `seed ${seed}: git saw a conflict we merged`).toBe(true);
        expect(r.text, `seed ${seed}`).toBe(readFileSync(o, "utf8"));
        merged++;
      } else conflicted++;
    }
    // Both outcomes occur on this generator.
    expect(merged).toBeGreaterThan(20);
    expect(conflicted).toBeGreaterThan(5);
  });
});
