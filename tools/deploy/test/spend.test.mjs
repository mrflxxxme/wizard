// Acceptance V3-01 (product.yaml#decisions.D77_v3 (18б), docs/plans/2026-10-08-v3.md §4–5): the spend journal of the
// v3 development — a paid run is pre-registered (purpose, hypothesis, expected ₽, cap) or does not start; > 1 000 ₽ at
// once or over the wave plan only with the founder's «да»; the cap stops the run; «потрачено X ₽ из плана Y ₽ волны …»;
// the journal docs/progress/v3-spend.json and its register / close / summary.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  capGuard,
  close,
  committedRub,
  EVAL_WAVES,
  FOUNDER_OK_OVER_RUB,
  JOURNAL,
  journalProblems,
  main,
  oneLine,
  preregister,
  readJournal,
  register,
  spendLine,
  summaryText,
  WAVES,
  waveLine,
} from "../spend.mjs";

const tmp = mkdtempSync(join(tmpdir(), "wizard-spend-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Group separator of ru-RU numbers in Node (U+202F or U+00A0) → a plain space, for readable expectations. */
const plain = (s) => s.replace(/[  ]/g, " ");
const OK = {
  wave: "A",
  purpose: "Проба этапа дизайна",
  hypothesis: "Новый промпт даёт 3 разных направления",
  expectRub: "20",
  capRub: "50",
};
const journal = (entries = []) => ({
  budgetRub: 12000,
  since: "2026-10-08",
  plan: { A: 2400, B: 1300, C: 500, checkpoint: 2000, final: 3600, retry: 1500, competitors: 1000 },
  entries,
});
const entry = (id, wave, capRub, actualRub) => ({
  id,
  date: "2026-10-09",
  wave,
  purpose: "п",
  hypothesis: "г",
  expectRub: 0,
  capRub,
  ...(actualRub === undefined ? {} : { actualRub }),
});

describe("the journal of the repository", () => {
  it("docs/progress/v3-spend.json is valid: budget 12 000 ₽ since 08.10, the plan of §5", () => {
    const j = readJournal(JOURNAL);
    expect(journalProblems(j)).toEqual([]);
    expect(j).toMatchObject({ budgetRub: 12000, since: "2026-10-08" });
    expect(j.plan).toEqual({
      A: 2400,
      B: 1300,
      C: 500,
      checkpoint: 2000,
      final: 3600,
      retry: 1500,
      competitors: 1000,
    });
    expect(Object.keys(j.plan)).toEqual(WAVES);
    expect(EVAL_WAVES.every((w) => WAVES.includes(w))).toBe(true);
  });

  it("a missing or broken journal is an error in Russian (a paid run does not start then)", () => {
    expect(() => readJournal(join(tmp, "none.json"))).toThrow(/журнал трат v3 не прочитан/);
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...journal(), plan: { A: 1 } }));
    expect(() => readJournal(bad)).toThrow(/журнал трат v3 повреждён.*plan\.B/);
    expect(journalProblems(journal([entry("v3-001", "A", 10), entry("v3-001", "Z", 0)]))).toEqual([
      "entries[1].id: нужен уникальный id вида v3-001",
      "entries[1].wave: неизвестная волна",
      "entries[1].capRub: нужен потолок в рублях",
    ]);
  });
});

describe("pre-registration (acceptance 1)", () => {
  it("without purpose, hypothesis, expected ₽, cap and wave the run does not start — every gap is named", () => {
    let err;
    try {
      preregister({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Платный прогон не начат — нужна запись в журнале трат v3: /);
    for (const what of ["(purpose)", "(hypothesis)", "(wave:", "(expect_rub)", "(cap_rub)"])
      expect(err.message).toContain(what);
    expect(() => preregister({ ...OK, purpose: "  \n " })).toThrow(/не указана цель \(purpose\)/);
    expect(() => preregister({ ...OK, wave: "D" })).toThrow(/не выбрана волна/);
    expect(() => preregister({ ...OK, capRub: "1.5" })).toThrow(/потолок \(cap_rub\): целое/);
    expect(() => preregister({ ...OK, capRub: "15001", founderOk: "yes" })).toThrow(/от 1 до 15/);
    expect(() => preregister({ ...OK, expectRub: "-1" })).toThrow(/expect_rub/);
    expect(() => preregister({ ...OK, expectRub: "60" })).toThrow(/ожидаемые 60 ₽ больше потолка 50 ₽/);
  });

  it("a complete record passes, normalised: numbers, one line each, no founder flag unless given", () => {
    expect(preregister({ ...OK, purpose: "Проба\nэтапа   дизайна", expectRub: "20,5" })).toEqual({
      wave: "A",
      purpose: "Проба этапа дизайна",
      hypothesis: OK.hypothesis,
      expectRub: 20.5,
      capRub: 50,
    });
    expect(oneLine("a\r\n\tb\u0007c")).toBe("a b c");
  });

  it("more than 1 000 ₽ at once — only with the founder's «да»", () => {
    expect(FOUNDER_OK_OVER_RUB).toBe(1000);
    expect(preregister({ ...OK, capRub: "1000" }).capRub).toBe(1000);
    expect(() => preregister({ ...OK, capRub: "1001" })).toThrow(
      /больше 1\s000 ₽ за раз — нужно «да» основателя \(founder_ok=yes\)/,
    );
    expect(() => preregister({ ...OK, capRub: "1001", founderOk: "no" })).toThrow(/founder_ok=yes/);
    expect(preregister({ ...OK, capRub: "3600", founderOk: "yes" })).toMatchObject({
      capRub: 3600,
      founderOk: true,
    });
  });

  it("over the wave plan (closed entries by their actual ₽, open ones by their cap) — only with the founder's «да»", () => {
    const j = journal([
      entry("v3-001", "C", 100, 80),
      entry("v3-002", "C", 300),
      entry("v3-003", "A", 900, 10),
    ]);
    expect(committedRub(j, "C")).toBe(380);
    expect(preregister({ ...OK, wave: "C", capRub: "120" }, j).capRub).toBe(120);
    expect(() => preregister({ ...OK, wave: "C", capRub: "121" }, j)).toThrow(
      /волна C может выйти за план: занято 380 ₽ из 500 ₽ — нужно «да» основателя/,
    );
    expect(preregister({ ...OK, wave: "C", capRub: "121", founderOk: "yes" }, j).founderOk).toBe(true);
    expect(() =>
      preregister({ ...OK, wave: "final", capRub: "900" }, journal([entry("v3-001", "final", 3000)])),
    ).toThrow(/волна «Финальный замер» может выйти за план/);
  });
});

describe("the cap stops the run (acceptance 1)", () => {
  it("capGuard: below the cap — go on; at the cap and over — the reason to stop", () => {
    const g = capGuard(300);
    expect(g(0)).toBeNull();
    expect(g(299.99)).toBeNull();
    expect(plain(g(300))).toBe("потолок прогона 300 ₽ достигнут (потрачено ≈ 300 ₽)");
    expect(plain(g(1234.4))).toBe("потолок прогона 300 ₽ достигнут (потрачено ≈ 1 234 ₽)");
    expect(g(Number.NaN)).toBeNull();
  });
});

describe("«потрачено X ₽ из плана Y ₽ волны» (acceptance 3)", () => {
  const j = journal([
    entry("v3-001", "A", 100, 40.4),
    entry("v3-002", "A", 300, 260),
    entry("v3-003", "B", 50),
  ]);
  it("the wave: closed entries only, plus the run not in the journal yet; the total of v3", () => {
    expect(plain(waveLine(j, "A"))).toBe("потрачено 300 ₽ из плана 2 400 ₽ волны A");
    expect(plain(spendLine(j, "A", 247))).toBe(
      "потрачено 547 ₽ из плана 2 400 ₽ волны A; всего по v3 — 547 ₽ из 12 000 ₽",
    );
    expect(plain(waveLine(j, "checkpoint"))).toBe(
      "потрачено 0 ₽ из плана 2 000 ₽ волны «Чекпоинты основателя»",
    );
  });
  it("summary: a line per wave, the total and the open entries", () => {
    const s = plain(summaryText(j));
    expect(s.split("\n")).toHaveLength(WAVES.length + 2);
    expect(s).toContain("- потрачено 0 ₽ из плана 1 300 ₽ волны B");
    expect(s).toContain("- потрачено 0 ₽ из плана 3 600 ₽ волны «Финальный замер»");
    expect(s).toContain("Всего: потрачено 300 ₽ из 12 000 ₽ бюджета v3; записей 3, открытых 1 (v3-003).");
  });
});

describe("register / close / summary", () => {
  it("register numbers entries v3-NNN with the Moscow date; close sets the actual ₽; the input journal is kept", () => {
    const j0 = journal([entry("v3-007", "B", 50, 20)]);
    const now = () => new Date("2026-10-08T22:30:00Z"); // 9 October 01:30 MSK
    const r = register(j0, { ...OK, runId: "20261009-abc123" }, { now });
    expect(r.entry).toEqual({
      id: "v3-008",
      date: "2026-10-09",
      wave: "A",
      purpose: OK.purpose,
      hypothesis: OK.hypothesis,
      expectRub: 20,
      capRub: 50,
      runId: "20261009-abc123",
    });
    expect(j0.entries).toHaveLength(1);
    expect(() => register(j0, { ...OK, capRub: "" }, { now })).toThrow(/Платный прогон не начат/);
    const c = close(r.journal, { id: "v3-008", actualRub: "31.456", result: "пройдено\n2 из 2" });
    expect(c.entry).toMatchObject({ actualRub: 31.46, result: "пройдено 2 из 2" });
    expect(() => close(r.journal, { id: "v3-008" })).toThrow(/нужен --actual-rub/);
    expect(() => close(r.journal, { id: "v3-999", actualRub: "1" })).toThrow(/нет записи v3-999/);
    expect(() => close(r.journal, { id: "v3-008", actualRub: "-3" })).toThrow(/actual_rub/);
  });

  it("the command line on a journal file: register, register --entry (the report's file), close, summary", () => {
    const file = join(tmp, "journal.json");
    writeFileSync(file, JSON.stringify(journal()));
    const out = [];
    const log = (s) => out.push(plain(s));
    const now = () => new Date("2026-10-09T09:00:00Z");
    main(
      [
        "register",
        "--file",
        file,
        "--wave",
        "A",
        "--purpose",
        "Проба интервью",
        "--hypothesis",
        "Хватит 7 вопросов",
        "--expect-rub",
        "15",
        "--cap-rub",
        "30",
      ],
      { log, now },
    );
    expect(out.at(-1)).toBe(
      "v3-001: записано — потрачено 0 ₽ из плана 2 400 ₽ волны A; всего по v3 — 0 ₽ из 12 000 ₽",
    );
    const reported = join(tmp, "spend-entry.json");
    writeFileSync(
      reported,
      JSON.stringify({
        date: "2026-10-09",
        wave: "A",
        purpose: "Сквозная сборка",
        hypothesis: "Укладывается в 500 ₽",
        expectRub: 300,
        capRub: 500,
        actualRub: 247,
        result: "засчитано 1 из 1, порог пройден",
        runId: "20261009-0a0b0c",
      }),
    );
    main(["register", "--file", file, "--entry", reported], { log, now });
    expect(out.at(-1)).toBe(
      "v3-002: записано — потрачено 247 ₽ из плана 2 400 ₽ волны A; всего по v3 — 247 ₽ из 12 000 ₽",
    );
    main(["close", "--file", file, "--id", "v3-001", "--actual-rub", "12", "--result", "7 вопросов"], {
      log,
    });
    expect(out.at(-1)).toBe(
      "v3-001: закрыто — потрачено 259 ₽ из плана 2 400 ₽ волны A; всего по v3 — 259 ₽ из 12 000 ₽",
    );
    main(["summary", "--file", file, "--wave", "A"], { log });
    expect(out.at(-1)).toBe("потрачено 259 ₽ из плана 2 400 ₽ волны A; всего по v3 — 259 ₽ из 12 000 ₽");
    main(["summary", "--file", file], { log });
    expect(out.at(-1)).toContain("записей 2, открытых 0.");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(journalProblems(saved)).toEqual([]);
    expect(saved.entries.map((e) => [e.id, e.actualRub, e.runId ?? null])).toEqual([
      ["v3-001", 12, null],
      ["v3-002", 247, "20261009-0a0b0c"],
    ]);
    expect(() => main(["register", "--file", file, "--wave", "A"], { log })).toThrow(
      /Платный прогон не начат/,
    );
    expect(() => main(["spend", "--file", file], { log })).toThrow(/register \| close \| summary/);
    expect(() => main(["summary", "--file", file, "--bogus", "1"], { log })).toThrow(/неизвестный аргумент/);
  });
});
