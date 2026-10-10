// GS-reports-1: the number of a KPI tile as the owner reads it — the compact notation of large sums (ui-kit
// formatMoneyCompact: «18,6 тыс. ₽») is the sum itself, not 18.6 (final measurement 10.10.2026, farm shop v3-12).
import { describe, expect, test } from "vitest";
import { kpiValue, PANEL_READY_MS, REPORTS_PROGRAMS } from "../src/goals/programs/reports.js";

describe("kpiValue", () => {
  test("full and compact sums, counts and percents; no number → null", () => {
    expect(kpiValue("18 600 ₽")).toBe(18600);
    expect(kpiValue("18,6 тыс. ₽")).toBe(18600);
    expect(kpiValue("1,2 млн ₽")).toBe(1_200_000);
    expect(kpiValue("3 млрд ₽")).toBe(3e9);
    expect(kpiValue("12")).toBe(12);
    expect(kpiValue("62 %")).toBe(62);
    expect(kpiValue("-5 тыс. ₽")).toBe(-5000);
    expect(kpiValue("—")).toBeNull();
  });
});

// V3-40 (v3-10 of the final measurement): the panel of a big plan rendered its tiles after the 5 s GS-reports-1 waited,
// so the check reported a tile that was there as missing. A panel whose tiles appear after 7 s passes now; a panel that
// never shows a tile fails with that reason, not with one metric's name.
describe("GS-reports-1 waits for a slow panel", () => {
  const PANEL = `import { useQuery } from "@wizard/sdk";
const TILES: Tile[] = [
  { id: "new_clients", label: "Новых клиентов", unit: "count", better: "up", goalText: "" },
];
export default function P() { useQuery("goalMetrics", { period: "month" }); }`;
  const run = (renderAfterMs: number | null) => {
    let rendered = false;
    const kpi = (sel: string) => ({
      first: () => kpi(sel),
      async waitFor(o: { timeout: number }) {
        if (renderAfterMs === null || o.timeout < renderAfterMs) throw new Error("timeout");
        rendered = true;
      },
      async count() {
        return rendered ? 1 : 0;
      },
      async innerText() {
        return sel.endsWith(" dd") ? "3" : "Новых клиентов 3";
      },
    });
    const t = {
      spec: {
        roles: [{ name: "owner", access: "login", admin: true }],
        pages: [{ route: "/cabinet/goals", file: "ui/pages/Goals.tsx", roles: ["owner"] }],
      },
      files: new Map([["ui/pages/Goals.tsx", PANEL]]),
      page: { locator: kpi },
      step() {},
      async as() {},
      async open() {},
      async api() {
        return { status: 200, body: { result: { metrics: [{ id: "new_clients", value: 3 }], reports: [] } } };
      },
      fail(reason: string): never {
        throw new Error(reason);
      },
    };
    return (REPORTS_PROGRAMS["GS-reports-1"] as (t: unknown) => Promise<void>)(t);
  };

  test("tiles after 7 s: passes (it waits up to PANEL_READY_MS)", async () => {
    expect(PANEL_READY_MS).toBeGreaterThanOrEqual(15_000);
    await expect(run(7_000)).resolves.toBeUndefined();
  });

  test("no tile ever: the panel did not show its numbers — said so", async () => {
    await expect(run(null)).rejects.toThrow(/панель цели не показала ни одного показателя за 20 с/);
  });
});
