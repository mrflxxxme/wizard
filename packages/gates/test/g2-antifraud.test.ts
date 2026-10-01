// backlog M2-04 / M2 exit: G2 blocks 100% of test/antifraud/block, 0 false blocks on test/antifraud/allow (eval briefs,
// mockups 1–10, abuse.yaml allow_required), G2-AF-08 scores; static per-check fixtures test/fixtures/G2-*; fresh
// generated data and fixtures.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
// @ts-expect-error — plain ESM script without types
import { buildData, DATA_DIR } from "../scripts/gen-g2-data.mjs";
// @ts-expect-error — plain ESM script without types
import { antifraudCases, checkCases } from "../scripts/gen-g2-fixtures.mjs";
import { type Check, G2_CHECKS, runG2 } from "../src/index.js";
import {
  ANTIFRAUD_DIR,
  DYNAMIC_IDS,
  FIXTURES_DIR,
  materialize,
  readCases,
  STATIC_IDS,
} from "./g2-helpers.js";
import { connect } from "./helpers.js";

const db = connect();
afterAll(async () => {
  await db.end();
});

const bad = (checks: Check[]) =>
  checks.filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"));
const show = (checks: Check[]) => JSON.stringify(checks, null, 1).slice(0, 2500);

describe("generated data and fixtures are fresh", () => {
  test("data/*.json = scripts/gen-g2-data.mjs(abuse.yaml)", () => {
    const { abuse, brands } = buildData();
    expect(JSON.parse(readFileSync(join(DATA_DIR, "abuse.json"), "utf8"))).toEqual(abuse);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "brands.ru.json"), "utf8"))).toEqual(brands);
  });

  test("test/antifraud and test/fixtures/G2-* = scripts/gen-g2-fixtures.mjs", () => {
    const af = readCases(ANTIFRAUD_DIR);
    const fresh = antifraudCases() as { dir: string; name: string; case: unknown }[];
    expect([...af.keys()].sort()).toEqual(fresh.map((c) => `${c.dir}/${c.name}.json`).sort());
    for (const c of fresh) expect(af.get(`${c.dir}/${c.name}.json`), c.name).toEqual(c.case);
    const dirs = readdirSync(FIXTURES_DIR).filter((d) => d.startsWith("G2-"));
    const fx = new Map<string, unknown>();
    for (const d of dirs)
      for (const f of readdirSync(join(FIXTURES_DIR, d)))
        fx.set(`${d}/${f}`, JSON.parse(readFileSync(join(FIXTURES_DIR, d, f), "utf8")));
    const freshChecks = checkCases() as { check: string; name: string; case: unknown }[];
    expect([...fx.keys()].sort()).toEqual(freshChecks.map((c) => `${c.check}/${c.name}.json`).sort());
    for (const c of freshChecks) expect(fx.get(`${c.check}/${c.name}.json`), c.name).toEqual(c.case);
  });

  test("abuse.yaml#scoring.fixtures: ≥ 40 block, ≥ 20 allow (incl. every eval brief and mockups 1–10)", () => {
    const af = [...readCases(ANTIFRAUD_DIR).keys()];
    expect(af.filter((k) => k.startsWith("block/")).length).toBeGreaterThanOrEqual(40);
    expect(af.filter((k) => k.startsWith("allow/")).length).toBeGreaterThanOrEqual(20);
    const briefs = readdirSync(join(ANTIFRAUD_DIR, "../../../../tools/eval/briefs")).filter((f) =>
      f.endsWith(".json"),
    );
    for (const b of briefs) expect(af).toContain(`allow/brief-${b.replace(/\.json$/, "")}.json`);
    for (let i = 1; i <= 10; i++) expect(af).toContain(`allow/mockup-${String(i).padStart(2, "0")}.json`);
  });

  test("every G2 check has a positive and a negative fixture (gates.yaml#report.rules)", () => {
    const cases = [...readCases(FIXTURES_DIR).entries()].filter(([k]) => k.startsWith("G2-"));
    for (const d of G2_CHECKS) {
      const mine = cases.filter(([k]) => k.startsWith(`${d.id}/`)).map(([, c]) => c);
      expect(
        mine.some((c) => c.expect === "pass"),
        `${d.id} pass`,
      ).toBe(true);
      expect(
        mine.some((c) => c.expect !== "pass"),
        `${d.id} negative`,
      ).toBe(true);
    }
  });
});

const cases = readCases(ANTIFRAUD_DIR);

describe("antifraud fixtures: block 100%", () => {
  for (const [name, c] of [...cases].filter(([k]) => k.startsWith("block/"))) {
    test(name, async () => {
      const { ctx } = materialize(c, db);
      const r = await runG2(ctx, { only: STATIC_IDS });
      expect(r.passed, show(r.checks)).toBe(false);
      const hit = r.checks.filter((x) => x.id === c.check && x.status === "fail");
      expect(hit.length, `${c.check}: ${show(r.checks.filter((x) => x.id === c.check))}`).toBeGreaterThan(0);
    });
  }
});

describe("antifraud fixtures: allow — 0 false blocks", () => {
  for (const [name, c] of [...cases].filter(([k]) => k.startsWith("allow/"))) {
    test(name, async () => {
      const { ctx } = materialize(c, db);
      const r = await runG2(ctx, { only: STATIC_IDS });
      expect(bad(r.checks), show(bad(r.checks))).toEqual([]);
    });
  }
});

describe("antifraud fixtures: risk score (G2-AF-08)", () => {
  for (const [name, c] of [...cases].filter(([k]) => k.startsWith("score/"))) {
    test(name, async () => {
      const { ctx } = materialize(c, db);
      const r = await runG2(ctx, { only: ["G2-AF-08"] });
      const s = r.checks.find((x) => x.id === "G2-AF-08");
      expect(s?.status, show(r.checks)).toBe(c.expect);
      if (c.expect === "warn") {
        expect(s?.evidence).toContain("founder_review");
        expect(r.passed).toBe(true);
      }
    });
  }
});

describe("per-check fixtures (static checks)", () => {
  const fx = [...readCases(FIXTURES_DIR)].filter(
    ([k]) => k.startsWith("G2-") && !DYNAMIC_IDS.includes(k.split("/")[0] as string),
  );
  for (const [name, c] of fx) {
    test(name, async () => {
      const { ctx } = materialize(c, db);
      const r = await runG2(ctx, { only: [c.check as string] });
      const mine = r.checks.filter((x) => x.id === c.check);
      expect(mine.length).toBeGreaterThan(0);
      if (c.expect === "pass")
        expect(
          mine.every((x) => x.status === "pass"),
          show(mine),
        ).toBe(true);
      else {
        const hits = mine.filter((x) => x.status === c.expect);
        expect(hits.length, show(mine)).toBeGreaterThan(0);
        if (c.match)
          expect(
            hits.some((x) => `${x.message_ru} ${x.evidence ?? ""}`.includes(c.match as string)),
            show(hits),
          ).toBe(true);
      }
    });
  }
});

test("antifraud messages are neutral (abuse.yaml#messages_ru) and evidence has no digits of card numbers", async () => {
  const c = cases.get("block/p2p-card.json");
  if (!c) throw new Error("fixture");
  const { ctx } = materialize(c, db);
  const r = await runG2(ctx, { only: ["G2-AF-06"] });
  const f = r.checks.find((x) => x.status === "fail");
  expect(f?.message_ru).toMatch(/^Публикация приостановлена/);
  expect(f?.evidence ?? "").not.toMatch(/\d{4}/);
});
