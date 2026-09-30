// @wizard/pii/import: readTable limits (L3-37), profiles, SyntheticPayload (data-boundary.yaml#import).
import { Faker, ru } from "@faker-js/faker";
import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  buildMappingPayload,
  IMPORT_LIMITS,
  ImportError,
  isSyntheticPayload,
  MAX_SYNTHETIC_ROWS,
  profileSheet,
  readTable,
  type Sheet,
  shapeOf,
  writeXlsx,
} from "../src/import/index.js";
import { detect, isPlaceholder } from "../src/index.js";
import { canaryGrid, canaryNeedles, canaryRows } from "./import-canaries.js";

const enc = new TextEncoder();

function expectImportError(fn: () => unknown, code: string, status: number) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    expect((e as ImportError).code).toBe(code);
    expect((e as ImportError).httpStatus).toBe(status);
    return;
  }
  throw new Error(`expected ImportError ${code}`);
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A package with hand-written parts (shared strings, styles, date1904…) on top of writeXlsx's skeleton. */
function rawXlsx(sheetXml: string, extra: Record<string, string> = {}, level: 0 | 1 | 6 | 9 = 6): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": enc.encode(
      extra["xl/workbook.xml"] ??
        `<workbook xmlns:r="${REL}"><sheets><sheet name="Данные" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": enc.encode(sheetXml),
  };
  for (const [k, v] of Object.entries(extra)) if (k !== "xl/workbook.xml") files[k] = enc.encode(v);
  return zipSync(files, { level });
}

describe("readTable: xlsx", () => {
  test("strings, numbers, booleans; first non-empty row is the header", () => {
    const bytes = writeXlsx([
      {
        name: "Клиенты",
        rows: [[], ["Имя", "Сумма", "Активен"], ["Анна", 10.5, true], [null, null, null], ["Олег", 7, false]],
      },
    ]);
    const t = readTable(bytes, { filename: "clients.xlsx" });
    expect(t.format).toBe("xlsx");
    expect(t.sheets).toEqual([
      {
        name: "Клиенты",
        header: ["Имя", "Сумма", "Активен"],
        rows: [
          ["Анна", 10.5, true],
          ["Олег", 7, false],
        ],
      },
    ]);
  });

  test("formulas are never evaluated: the cached value is used, no cached value → empty", () => {
    const bytes = writeXlsx([
      {
        name: "Л",
        rows: [
          ["a", "b", "c"],
          [1, { f: "A2*1000", v: 42 }, { f: "NOW()" }],
          [2, { f: 'HYPERLINK("http://evil.example/x","клик")', v: "клик" }, { f: "1/0", v: true }],
        ],
      },
    ]);
    const t = readTable(bytes);
    expect(t.sheets[0]?.rows).toEqual([
      [1, 42, null],
      [2, "клик", true],
    ]);
  });

  test("external links and macros are ignored; only the cached value of an external reference is read", () => {
    const secret = "СЕКРЕТ_ИЗ_ВНЕШНЕЙ_КНИГИ";
    const bytes = writeXlsx([{ name: "Л", rows: [["ссылка"], [{ f: "[1]Лист1!A1", v: "кэш" }]] }], {
      extraParts: {
        "xl/externalLinks/externalLink1.xml": `<externalLink><externalBook><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1" t="str"><v>${secret}</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
        "xl/externalLinks/_rels/externalLink1.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/externalLinkPath" Target="file:///C:/secret.xlsx" TargetMode="External"/></Relationships>`,
        "xl/vbaProject.bin": secret,
        "xl/connections.xml": `<connections><connection id="1" name="${secret}"/></connections>`,
      },
      extraWorkbookRels: [
        `<Relationship Id="rId90" Type="${REL}/externalLink" Target="externalLinks/externalLink1.xml"/>`,
        `<Relationship Id="rId91" Type="${REL}/worksheet" Target="http://evil.example/sheet.xml" TargetMode="External"/>`,
      ],
    });
    const t = readTable(bytes);
    expect(t.sheets[0]?.rows).toEqual([["кэш"]]);
    expect(JSON.stringify(t)).not.toContain(secret);
  });

  test("shared strings, rich text, inline strings, date styles and the 1904 system", () => {
    const sst = `<sst><si><t>Дата</t></si><si><r><t>Иван</t></r><r><t xml:space="preserve"> Петров</t></r><rPh><t>ignored</t></rPh></si><si><t>a&amp;b_x000D_</t></si></sst>`;
    const styles = `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`;
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2" s="2"><v>45292.5</v></c><c r="C2" t="inlineStr"><is><t>x</t></is></c><c r="D2" t="s"><v>2</v></c><c r="E2" t="e"><v>#REF!</v></c></row></sheetData></worksheet>`;
    const t = readTable(rawXlsx(sheet, { "xl/sharedStrings.xml": sst, "xl/styles.xml": styles }));
    expect(t.sheets[0]?.header).toEqual(["Дата", "Иван Петров", "", ""]);
    expect(t.sheets[0]?.rows).toEqual([["2024-01-01", "2024-01-01T12:00:00", "x", "a&b\r"]]);
    const wb1904 = `<workbook xmlns:r="${REL}"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const t2 = readTable(
      rawXlsx(sheet, { "xl/sharedStrings.xml": sst, "xl/styles.xml": styles, "xl/workbook.xml": wb1904 }),
    );
    expect(t2.sheets[0]?.rows[0]?.[0]).toBe("2028-01-02");
  });

  test("limits: the defaults are 20 MB file, 100 MB unpacked, 1 000 000 cells", () => {
    expect(IMPORT_LIMITS).toEqual({
      maxFileBytes: 20 * 1024 * 1024,
      maxUnpackedBytes: 100 * 1024 * 1024,
      maxCells: 1_000_000,
    });
  });

  test("file over 20 MB → 413 FILE_TOO_LARGE", () => {
    expectImportError(() => readTable(new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1)), "FILE_TOO_LARGE", 413);
  });

  test("zip bomb with honest sizes (> 100 MB declared) → 413 before inflating", () => {
    const pad = " ".repeat(1024 * 1024);
    const huge = `<worksheet><sheetData>${pad.repeat(101)}</sheetData></worksheet>`;
    const bytes = rawXlsx(huge, {}, 1);
    expect(bytes.length).toBeLessThan(IMPORT_LIMITS.maxFileBytes);
    expectImportError(() => readTable(bytes), "UNPACKED_TOO_LARGE", 413);
  });

  test("zip bomb with forged sizes: the real inflated bytes are counted", () => {
    const pad = " ".repeat(1024 * 1024);
    const bytes = rawXlsx(`<worksheet><sheetData>${pad.repeat(101)}</sheetData></worksheet>`, {}, 1);
    // Forge the central-directory uncompressed size of every entry to 1 KB.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 46 <= bytes.length; i++)
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1024, true);
    expectImportError(() => readTable(bytes), "UNPACKED_TOO_LARGE", 413);
    // Same mechanism under a small custom limit.
    const small = writeXlsx([{ name: "S", rows: [["x"], ["y".repeat(5000)]] }]);
    expectImportError(
      () => readTable(small, { limits: { maxUnpackedBytes: 2000 } }),
      "UNPACKED_TOO_LARGE",
      413,
    );
  });

  test("more than 1 000 000 non-empty cells → 413 TOO_MANY_CELLS; exactly the limit passes a smaller cap", () => {
    const row = `<row>${"<c><v>1</v></c>".repeat(1001)}</row>`;
    const bytes = rawXlsx(`<worksheet><sheetData>${row.repeat(1000)}</sheetData></worksheet>`, {}, 1);
    expectImportError(() => readTable(bytes), "TOO_MANY_CELLS", 413);
    const grid = [["a", "b"], ...Array.from({ length: 49 }, () => [1, 2])];
    expect(
      readTable(writeXlsx([{ name: "S", rows: grid }]), { limits: { maxCells: 100 } }).sheets[0]?.rows,
    ).toHaveLength(49);
    expectImportError(
      () => readTable(writeXlsx([{ name: "S", rows: [...grid, [3]] }]), { limits: { maxCells: 100 } }),
      "TOO_MANY_CELLS",
      413,
    );
  });

  test("legacy .xls and broken zips are refused with 400", () => {
    expectImportError(
      () => readTable(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])),
      "UNSUPPORTED_FORMAT",
      400,
    );
    expectImportError(() => readTable(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), "BAD_FILE", 400);
  });
});

describe("readTable: csv", () => {
  test("semicolon, quotes, CRLF, BOM", () => {
    const csv =
      '\ufeffИмя;Комментарий;Сумма\r\n"Анна";"Сказала ""да""; позже";10,5\r\nОлег;"две\nстроки";7\r\n';
    const t = readTable(enc.encode(csv), { filename: "clients.csv" });
    expect(t).toEqual({
      format: "csv",
      sheets: [
        {
          name: "clients",
          header: ["Имя", "Комментарий", "Сумма"],
          rows: [
            ["Анна", 'Сказала "да"; позже', "10,5"],
            ["Олег", "две\nстроки", "7"],
          ],
        },
      ],
    });
  });

  test("Windows-1251 is decoded; tab delimiter", () => {
    // "Имя\tГород\nАнна\tТверь\n" in cp1251
    const bytes = new Uint8Array([
      0xc8, 0xec, 0xff, 0x09, 0xc3, 0xee, 0xf0, 0xee, 0xe4, 0x0a, 0xc0, 0xed, 0xed, 0xe0, 0x09, 0xd2, 0xe2,
      0xe5, 0xf0, 0xfc, 0x0a,
    ]);
    expect(readTable(bytes).sheets[0]).toEqual({
      name: "Лист1",
      header: ["Имя", "Город"],
      rows: [["Анна", "Тверь"]],
    });
  });

  test("cell limit applies to csv", () => {
    expectImportError(
      () => readTable(enc.encode("a,b\n1,2\n3,4\n"), { limits: { maxCells: 5 } }),
      "TOO_MANY_CELLS",
      413,
    );
  });
});

describe("profileSheet", () => {
  const sheet: Sheet = {
    name: "Клиенты",
    header: ["ФИО", "Телефон", "ИНН", "Сумма", "Дата", "Комментарий", "Пусто", "Код"],
    rows: [
      [
        "Иванов Иван Иванович",
        "+7 916 123-45-67",
        "500100732259",
        1234.5,
        "2024-01-05",
        "Позвонить после обеда, уточнить адрес доставки и время когда удобно",
        null,
        "AB-1234",
      ],
      [
        "Петрова Анна Сергеевна",
        "+7 903 765-43-21",
        "500100732259",
        98765,
        "2024-02-11",
        "Клиент просил не звонить в выходные, только писать сообщения в мессенджер",
        null,
        "CD-5678",
      ],
      ["Сидоров Пётр", "+7 926 000-11-22", "123456789012", 12, "2024-03-01", null, null, "EF-9012"],
    ],
  };
  const p = profileSheet(sheet);
  const col = (h: string) => p.columns.find((c) => c.header === h);

  test("types, pii guesses, shares", () => {
    expect(p.rowCount).toBe(3);
    expect(col("ФИО")).toMatchObject({
      inferredType: "string",
      piiKindGuess: "fio",
      nullShare: 0,
      distinctRatio: 1,
    });
    expect(col("Телефон")).toMatchObject({
      inferredType: "phone",
      piiKindGuess: "phone",
      pattern: "+# ### ###-##-##",
    });
    expect(col("ИНН")).toMatchObject({ piiKindGuess: "inn", checksumValidShare: 0.67 });
    expect(col("Дата")).toMatchObject({ inferredType: "date", pattern: "####-##-##" });
    expect(col("Пусто")).toMatchObject({ inferredType: "empty", nullShare: 1, pattern: null });
    expect(col("Код")).toMatchObject({ inferredType: "string", pattern: "X-####", piiKindGuess: null });
  });

  test("numeric columns expose only rounded min/max; free text only its average length", () => {
    expect(col("Сумма")).toMatchObject({ inferredType: "number", min: 12, max: 99000 });
    const note = col("Комментарий");
    expect(note?.inferredType).toBe("free_text");
    expect(note?.summary).toMatch(/^free_text, средняя длина \d+$/);
    expect(note?.pattern).toBeNull();
  });

  test("shapeOf keeps structure, not content", () => {
    expect(shapeOf("Иванов Иван")).toBe("Бб Бб");
    expect(shapeOf("ivan.petrov@mail.ru")).toBe("x.x@x.x");
    expect(shapeOf("А123ВС 77")).toBe("Б###Б ##");
  });
});

describe("buildMappingPayload (SyntheticPayload)", () => {
  const rows = canaryRows(50);
  const grid = canaryGrid(rows);
  const table = readTable(writeXlsx([{ name: "Клиенты", rows: grid }]));
  const needles = canaryNeedles(rows);

  test("no real value of the table is in the payload; ≤ 5 synthetic rows", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const payload = buildMappingPayload(table, { seed });
      const json = JSON.stringify(payload);
      for (const n of needles) expect(json, `seed ${seed}: ${n}`).not.toContain(n);
      for (const s of payload.sheets) expect(s.syntheticRows.length).toBeLessThanOrEqual(MAX_SYNTHETIC_ROWS);
    }
  });

  test("every string passes detect() with 0 findings; PII columns get placeholders", () => {
    const payload = buildMappingPayload(table, { seed: 7 });
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(payload);
    for (const s of strings) if (!isPlaceholder(s)) expect(detect(s), s).toEqual([]);
    const sheet = payload.sheets[0];
    expect(sheet?.name).toBe("Клиенты");
    expect(sheet?.columns.map((c) => c.header)).toEqual([
      "ФИО клиента",
      "Телефон",
      "Почта",
      "Город",
      "Сумма заказа",
      "Комментарий",
    ]);
    expect(sheet?.columns.map((c) => c.piiKindGuess)).toEqual(["fio", "phone", "email", null, null, "other"]);
    expect(sheet?.syntheticRows[0]?.slice(0, 3)).toEqual(["[ФИО_1]", "[ТЕЛЕФОН_1]", "[EMAIL_1]"]);
    expect(sheet?.syntheticRows).toHaveLength(5);
  });

  test("headers with findings become col_<n>; duplicates and empty headers too", () => {
    const s: Sheet = {
      name: "Лист1",
      header: ["Иванов Иван", "", "Статус", "статус", "ivan@mail.ru"],
      rows: [["a", "b", "c", "d", "e"]],
    };
    const payload = buildMappingPayload(s, { seed: 1 });
    expect(payload.sheets[0]?.columns.map((c) => c.header)).toEqual([
      "col_1",
      "col_2",
      "Статус",
      "col_4",
      "col_5",
    ]);
    expect(payload.sheets[0]?.name).toBe("Лист1");
    const named = buildMappingPayload([s, { ...s, name: "Петров Сергей" }], { seed: 1 });
    expect(named.sheets.map((x) => x.name)).toEqual(["Лист1", "sheet_2"]);
  });

  test("synthetic values never copy a real value, even when faker would produce one", () => {
    const f = new Faker({ locale: [ru] });
    f.seed(3);
    const departments = Array.from({ length: 400 }, () => f.commerce.department());
    const s: Sheet = { name: "S", header: ["Отдел"], rows: departments.map((d) => [d]) };
    const real = new Set(departments.map((d) => d.toLowerCase()));
    for (let seed = 1; seed <= 30; seed++) {
      for (const r of buildMappingPayload(s, { seed }).sheets[0]?.syntheticRows ?? []) {
        expect(real.has(String(r[0]).toLowerCase())).toBe(false);
      }
    }
  });

  test("branded and frozen: only buildMappingPayload creates a SyntheticPayload", () => {
    const payload = buildMappingPayload(table, { seed: 1 });
    expect(isSyntheticPayload(payload)).toBe(true);
    expect(isSyntheticPayload(structuredClone(payload))).toBe(false);
    expect(isSyntheticPayload({ sheets: [] })).toBe(false);
    expect(Object.isFrozen(payload.sheets[0]?.syntheticRows[0])).toBe(true);
    expect(() => {
      (payload.sheets[0]?.syntheticRows[0] as unknown[] | undefined)?.push("x");
    }).toThrow();
  });
});
