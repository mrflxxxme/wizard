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
