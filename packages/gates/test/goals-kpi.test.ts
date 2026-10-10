// GS-reports-1: the number of a KPI tile as the owner reads it — the compact notation of large sums (ui-kit
// formatMoneyCompact: «18,6 тыс. ₽») is the sum itself, not 18.6 (final measurement 10.10.2026, farm shop v3-12).
import { describe, expect, test } from "vitest";
import { kpiValue } from "../src/goals/programs/reports.js";

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
