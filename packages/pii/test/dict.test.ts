import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { caseForms, nameDict } from "../src/dict.js";
import { NAMES_DATA } from "../src/names.data.js";

const TXT = readFileSync(new URL("../data/names.ru.txt", import.meta.url), "utf8");
const entries = TXT.split("\n").filter((l) => l && !l.startsWith("#"));
const flagged = (f: string) => entries.filter((l) => (l.split("\t")[1] ?? "").includes(f));

describe("names dictionary (data/names.ru.txt)", () => {
  test("src/names.data.ts is generated from data/names.ru.txt", () => {
    expect(NAMES_DATA.trim()).toBe(entries.join("\n"));
  });

  test("sizes: ≥ 1500 names incl. diminutives (data-boundary), ≥ 300 names and ≥ 300 surnames (M0-05)", () => {
    const names = entries.length - flagged("s").length;
    expect(names).toBeGreaterThanOrEqual(1500);
    expect(names - flagged("l").length).toBeGreaterThanOrEqual(300);
    expect(flagged("s").length).toBeGreaterThanOrEqual(300);
    expect(TXT).toMatch(/Provenance/);
    expect(TXT).toMatch(/CC0-1\.0/);
  });

  test("FU-1 sizes: ≥ 300 non-Slavic names, ≥ 200 non-Slavic surnames, ≥ 200 English/European names and surnames", () => {
    const flagsOf = (l: string) => l.split("\t")[1] ?? "";
    const both = (a: string, b: string) =>
      entries.filter((l) => flagsOf(l).includes(a) && flagsOf(l).includes(b)).length;
    expect(
      entries.filter((l) => flagsOf(l).includes("o") && /[mf]/.test(flagsOf(l))).length,
    ).toBeGreaterThanOrEqual(300);
    expect(both("o", "s")).toBeGreaterThanOrEqual(200);
    expect(both("w", "l")).toBeGreaterThanOrEqual(200);
    expect(both("w", "s")).toBeGreaterThanOrEqual(200);
    const { names, strongSurnames } = nameDict();
    expect(names.get("джахонгир")).toBeDefined();
    expect(strongSurnames.has("рахимовой")).toBe(true); // feminine case forms of -ов surnames
    expect(strongSurnames.has("smith")).toBe(true);
    expect(strongSurnames.has("мороз")).toBe(false); // also a common word
    expect(names.get("mark")?.word).toBe(true);
    expect(names.get("john")?.word).toBe(false);
  });

  test("FU-2 sizes: ≥ 300 names and ≥ 200 surnames beyond English/European; diacritics-insensitive lookups", () => {
    const flagsOf = (l: string) => l.split("\t")[1] ?? "";
    const both = (a: string, b: string) =>
      entries.filter((l) => flagsOf(l).includes(a) && flagsOf(l).includes(b)).length;
    expect(both("g", "l")).toBeGreaterThanOrEqual(300);
    expect(both("g", "s")).toBeGreaterThanOrEqual(200);
    const { names, strongSurnames } = nameDict();
    for (const n of ["hiroshi", "xiaoming", "min-jun", "priya", "fatima", "mehmet", "joaquin"]) {
      expect(names.get(n)?.word).toBe(false);
    }
    expect(names.get("sakura")?.word).toBe(true);
    expect(strongSurnames.has("tanaka")).toBe(true);
    expect(strongSurnames.has("suzuki")).toBe(false); // also a brand
  });

  test("case forms", () => {
    expect(caseForms("Иван", "m")).toEqual(expect.arrayContaining(["Ивана", "Ивану", "Иваном", "Иване"]));
    expect(caseForms("Мария", "f")).toEqual(expect.arrayContaining(["Марии", "Марию", "Марией"]));
    expect(caseForms("Дмитрий", "m")).toEqual(expect.arrayContaining(["Дмитрия", "Дмитрию", "Дмитрием"]));
    expect(caseForms("Никита", "m")).toEqual(
      expect.arrayContaining(["Никиты", "Никите", "Никиту", "Никитой"]),
    );
    expect(caseForms("Игорь", "m")).toEqual(expect.arrayContaining(["Игоря", "Игорем"]));
    expect(caseForms("Нелли", "f")).toEqual(["Нелли"]);
    const { names } = nameDict();
    expect(names.get("павла")).toBeDefined(); // irregular stem from the data file
    expect(names.get("льва")?.ambiguous).toBe(true);
    expect(names.get("яна")?.ambiguous).toBe(false); // Яна (name) wins over genitive of ambiguous Ян
  });
});
