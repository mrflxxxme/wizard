// V3-04 acceptance, agents part (D77 (8), builder-v3.md §3 C1, C7): ТЗ from a file → text on the platform server (docx,
// pdf, md, txt; the format by signature; Windows-1251 and KOI8-R), chunks for long text, the T0 call brief_extract with
// submit_brief_draft on recorded answers (fixture router, suite unit — the request key must match the real prompt), the
// heuristic draft without a model, scrub of the draft and briefGaps: the interview asks only what the ТЗ left empty —
// checked on three generated ТЗ samples. No live calls.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyBrief, systemBriefSchema } from "@wizard/appspec";
import {
  createRegistry,
  createRouter,
  type FixtureLine,
  type RouteInput,
  type RouteOutput,
} from "@wizard/llm";
import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { dentalBrief } from "../../appspec/test/brief-fixtures.js";
import { readDocx } from "../src/brief-extract/docx.js";
import {
  BRIEF_DRAFT_TODO,
  BRIEF_FILE_LIMITS,
  BRIEF_GAP_SECTIONS,
  type BriefDraftAnswer,
  BriefFileError,
  briefDraftTool,
  briefExtractMessages,
  briefGaps,
  chunkText,
  decodeText,
  detectBriefFileFormat,
  draftToBrief,
  extractBriefDraft,
  heuristicDraft,
  mergeBriefDraft,
  readBriefFile,
} from "../src/brief-extract/index.js";
import {
  BIKES,
  COFFEE,
  encode8bit,
  PLAIN_TZ,
  pdfOf,
  SAMPLES,
  sampleFile,
  TEA,
  type TzSample,
  toDocx,
  toMarkdown,
} from "./brief-extract-fixtures.js";
import { fixtureLine } from "./build-v2-fixtures.js";

const llm = createRegistry({ buildDefaultTier: "T1" });

async function fileError(p: Promise<unknown>): Promise<BriefFileError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BriefFileError) return e;
    throw e;
  }
  throw new Error("expected BriefFileError");
}

/** A fixture router over recorded lines (suite unit: answers by request key). */
function recorded(lines: FixtureLine[]) {
  const dir = mkdtempSync(join(tmpdir(), "wz-brief-"));
  mkdirSync(join(dir, "unit"), { recursive: true });
  writeFileSync(
    join(dir, "unit", "brief-extract.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "unit", name: "brief-extract", dir },
    registry: llm,
    sink: { write: async () => {} },
    env: {},
  });
  const outs: RouteOutput[] = [];
  const route = async (input: RouteInput) => {
    const out = await router.route({ ...input, orgPolicy: { ruOnly: false, t1Restricted: false } });
    outs.push(out);
    return out;
  };
  return { route, outs };
}

/** The recorded line of one chunk of a ТЗ text: the real prompt, the answer of the sample. */
function lineFor(chunk: string, part: number, parts: number, answer: BriefDraftAnswer): FixtureLine {
  return fixtureLine(
    "brief_extract",
    briefExtractMessages(chunk, part, parts),
    [briefDraftTool().definition],
    {
      name: "submit_brief_draft",
      args: answer,
    },
  );
}

/** A scripted model: each call gets the next answer (Error — thrown). */
function scripted(answers: (Record<string, unknown> | Error)[]) {
  const calls: RouteInput[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] as Record<string, unknown> | Error;
    if (a instanceof Error) throw a;
    return {
      tier: "T0",
      model: "gigachat-3.5",
      result: {
        toolCalls: [{ id: `c${calls.length}`, name: "submit_brief_draft", args: a }],
        finishReason: "tool-calls",
      },
      usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 600 },
      creditsCharged: 0.02,
      creditsMilli: 20,
      routeReason: "default_T0",
      scrubbed: false,
      ruFallback: false,
    };
  };
  return { route, calls };
}

const lines = (text: string) => text.split("\n");

describe("text of a ТЗ file", () => {
  test.each(SAMPLES.map((s) => [s.format, s] as const))(
    "%s: headings, list items and paragraphs of the sample, format by signature",
    async (_f, s: TzSample) => {
      const r = await readBriefFile(sampleFile(s));
      expect(r.format).toBe(s.format === "md" ? "text" : s.format);
      expect(r.truncated).toBe(false);
      expect(lines(r.text)[0]).toBe(`# ${s.title}`);
      for (const sec of s.sections) {
        expect(lines(r.text)).toContainEqual(expect.stringMatching(new RegExp(`^#{1,2} ${sec.heading}$`)));
        for (const p of sec.paragraphs ?? []) expect(r.text).toContain(p);
        for (const i of sec.items ?? []) expect(lines(r.text)).toContain(`- ${i}`);
      }
    },
  );

  test("docx: table rows, Russian heading style ids; deleted text, field codes and fallback copies skipped", async () => {
    const r = await readBriefFile(toDocx(COFFEE));
    expect(r.text).toContain("| Капучино | 220 ₽ |");
    expect(lines(r.text)).toContain("# Функции сайта");
    expect(r.text).toContain("надпись");
    for (const absent of ["удалённый текст", "PAGE", "копия надписи", "\t"])
      expect(r.text).not.toContain(absent);
  });

  test("pdf: page count, wrapped lines joined back, page numbers dropped, headings by font size", async () => {
    const r = await readBriefFile(sampleFile(BIKES));
    expect(r.pages).toBe(1);
    expect(r.text).toContain(BIKES.sections[0]?.paragraphs?.[0]);
    expect(lines(r.text)).not.toContain("1");
    expect(lines(r.text)).toContain("## Данные");
    // Many pages: the text of every page in order.
    const long = pdfOf(
      Array.from({ length: 90 }, (_, i) => ({ text: `Пункт номер ${i + 1}.`, size: 11 })),
      { perPage: 30 },
    );
    const many = await readBriefFile(long);
    expect(many.pages).toBe(3);
    expect(many.text.indexOf("Пункт номер 1.")).toBeLessThan(many.text.indexOf("Пункт номер 90."));
  });

  test("the extension does not matter: a renamed docx is a docx, md text with a pdf name is text", () => {
    expect(detectBriefFileFormat(toDocx(TEA))).toBe("docx");
    expect(detectBriefFileFormat(new TextEncoder().encode(toMarkdown(TEA)))).toBe("text");
    expect(detectBriefFileFormat(sampleFile(BIKES))).toBe("pdf");
  });

  test("txt in UTF-8 (with and without BOM), UTF-16 and the Russian code pages Windows-1251 and KOI8-R", async () => {
    const utf8 = new TextEncoder().encode(PLAIN_TZ);
    const utf16 = Uint8Array.from([
      0xff,
      0xfe,
      ...[...PLAIN_TZ].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
    ]);
    const cases: [Uint8Array, string][] = [
      [utf8, "utf-8"],
      [Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8]), "utf-8"],
      [utf16, "utf-16le"],
      [encode8bit(PLAIN_TZ, "windows-1251"), "windows-1251"],
      [encode8bit(PLAIN_TZ, "koi8-r"), "koi8-r"],
    ];
    for (const [bytes, encoding] of cases) {
      expect(decodeText(bytes).encoding).toBe(encoding);
      const r = await readBriefFile(bytes);
      expect(r).toMatchObject({ format: "text", encoding, text: PLAIN_TZ.trim() });
    }
    // CRLF, NBSP and soft hyphens are normalized.
    const messy = new TextEncoder().encode("Цели:\r\n- Запись­ онлайн\r\n\r\n\r\n\r\nКонец");
    expect((await readBriefFile(messy)).text).toBe("Цели:\n- Запись онлайн\n\nКонец");
  });

  test("refused files: size, images, old .doc, rtf, other zips, binaries, empty text, a scan, a zip bomb", async () => {
    const big = new Uint8Array(BRIEF_FILE_LIMITS.fileBytes + 1).fill(0x41);
    expect(await fileError(readBriefFile(big))).toMatchObject({ code: "FILE_TOO_LARGE", httpStatus: 413 });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const img = await fileError(readBriefFile(png));
    expect(img).toMatchObject({ code: "UNSUPPORTED_FORMAT", httpStatus: 415 });
    expect(img.message).toMatch(/Картинки/);
    const doc = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect((await fileError(readBriefFile(doc))).message).toMatch(/\.doc/);
    const rtf = new TextEncoder().encode("{\\rtf1\\ansi Текст}");
    expect((await fileError(readBriefFile(rtf))).message).toMatch(/RTF/);
    const xlsx = zipSync({ "xl/workbook.xml": new TextEncoder().encode("<workbook/>") });
    expect((await fileError(readBriefFile(xlsx))).message).toMatch(/импорт/);
    const binary = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    expect((await fileError(readBriefFile(binary))).code).toBe("UNSUPPORTED_FORMAT");
    expect((await fileError(readBriefFile(new Uint8Array(0)))).code).toBe("EMPTY_TEXT");
    expect((await fileError(readBriefFile(new TextEncoder().encode(" \n\n — \n")))).code).toBe("EMPTY_TEXT");
    const scan = await fileError(readBriefFile(pdfOf([])));
    expect(scan).toMatchObject({ code: "EMPTY_TEXT", httpStatus: 400 });
    expect(scan.message).toMatch(/скан/);
    expect((await fileError(readBriefFile(new TextEncoder().encode("%PDF-1.7\nмусор")))).code).toBe(
      "BAD_FILE",
    );
    // Zip bomb: the real inflated size counts against the budget, whatever the archive declares.
    const bomb = toDocx(COFFEE);
    expect(() => readDocx(bomb, { left: 1000 })).toThrow(
      expect.objectContaining({ code: "UNPACKED_TOO_LARGE" }),
    );
  });

  test("text over the limit is cut at a paragraph and marked truncated", async () => {
    const para = `${"Сценарий оформления заказа. ".repeat(40).trim()}\n\n`;
    const text = para.repeat(Math.ceil(BRIEF_FILE_LIMITS.textChars / para.length) + 5);
    const r = await readBriefFile(new TextEncoder().encode(text));
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(BRIEF_FILE_LIMITS.textChars);
    expect(r.chars).toBeGreaterThan(BRIEF_FILE_LIMITS.textChars);
    expect(r.text.endsWith("заказа.")).toBe(true);
  });
});

describe("chunks for the model", () => {
  test("paragraph boundaries, a heading past half a chunk starts the next one, long paragraphs split", () => {
    const text = ["# А", "x".repeat(600), "# Б", "y".repeat(300), "z".repeat(2500)].join("\n\n");
    const chunks = chunkText(text, 1000);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks[0]).toBe(`# А\n\n${"x".repeat(600)}`);
    expect(chunks[1]?.startsWith("# Б")).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    expect(chunkText("  ", 1000)).toEqual([]);
    expect(chunkText("короткий", 1000)).toEqual(["короткий"]);
  });
});

describe("draft on recorded answers of the model (three ТЗ samples)", () => {
  test.each(SAMPLES.map((s) => [s.name, s] as const))(
    "%s: the draft is what the ТЗ says; the interview asks only the missing sections",
    async (_n, s: TzSample) => {
      const { text } = await readBriefFile(sampleFile(s));
      expect(chunkText(text, BRIEF_FILE_LIMITS.chunkChars)).toHaveLength(1);
      const { route, outs } = recorded([lineFor(text, 1, 1, s.answer)]);
      const r = await extractBriefDraft({ text, route, ctx: { orgId: "org" } });
      expect(r).toMatchObject({ method: "model", chunks: 1, answered: 1, pii: { found: 0 } });
      expect(r.brief).toEqual(draftToBrief(s.answer));
      // brief_extract is T0 only (data-boundary.yaml#call_types.brief_extract): the text never left the RF.
      expect(outs.map((o) => o.tier)).toEqual(["T0"]);
      expect(outs[0]?.model).toBe("gigachat-3.5");
      const gaps = briefGaps(r.brief);
      expect(gaps.missing).toEqual(s.missing);
      expect(gaps.blocking).toEqual(s.blocking);
      expect(gaps.filled).toEqual(BRIEF_GAP_SECTIONS.filter((x) => !s.missing.includes(x)));
      // Nothing outside the ТЗ: qa, assumptions, the capability map and the archetype stay empty.
      expect(r.brief).toMatchObject({ qa: [], assumptions: [], capability: [] });
      expect(r.brief.design.archetype).toBeUndefined();
    },
  );

  test("the samples differ in what is missing: the interview of each asks other questions", () => {
    expect(new Set(SAMPLES.map((s) => s.missing.join())).size).toBe(3);
    const coffee = briefGaps(draftToBrief(COFFEE.answer)).sections.find((x) => x.section === "goals");
    expect(coffee).toMatchObject({ status: "partial", blocking: true });
    expect(coffee?.notes[0]).toContain("Показать меню и цены");
    const tea = briefGaps(draftToBrief(TEA.answer)).sections.find((x) => x.section === "data");
    expect(tea?.notes).toEqual(["Не указан срок хранения: «Покупатель»"]);
  });

  test("a long ТЗ: two chunks answered separately, merged with unique ids and goal references kept", async () => {
    const { text } = await readBriefFile(sampleFile(TEA));
    const chunks = chunkText(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    const first: BriefDraftAnswer = {
      ...TEA.answer,
      data: [],
      integrations: [],
      outOfScope: [],
      references: [],
    };
    const second: BriefDraftAnswer = {
      ...TEA.answer,
      audience: "Другое описание",
      goals: [{ id: "g_sales", text: "Продавать подарочные наборы", success: "20 наборов в месяц" }],
      scenarios: [
        { ...(TEA.answer.scenarios[0] as BriefDraftAnswer["scenarios"][number]), goalId: "g_sales" },
      ],
    };
    const answers = chunks.map((_, i) =>
      i === 0 ? first : i === 1 ? second : { ...first, goals: [], scenarios: [], audience: "" },
    );
    const { route, outs } = recorded(
      chunks.map((c, i) => lineFor(c, i + 1, chunks.length, answers[i] as BriefDraftAnswer)),
    );
    const r = await extractBriefDraft({ text, route, chunkChars: 400 });
    expect(r).toMatchObject({ method: "model", chunks: chunks.length, answered: chunks.length });
    expect(outs).toHaveLength(chunks.length);
    expect(r.brief.goals.map((g) => g.id)).toEqual(["g_sales", "g_sales_2"]);
    expect(r.brief.audience).toBe(TEA.answer.audience);
    const fromSecond = r.brief.scenarios.at(-1);
    expect(fromSecond?.goalId).toBe("g_sales_2");
    expect(new Set(r.brief.scenarios.map((x) => x.id)).size).toBe(r.brief.scenarios.length);
    expect(r.brief.data.map((d) => d.entity)).toEqual(["Заказ", "Покупатель"]);
    expect(r.brief.integrations).toHaveLength(2);
  });

  test("a refused answer is repaired once; personal data in the answer is scrubbed before it is stored", async () => {
    const broken = { ...BIKES.answer, scenarios: [{ ...BIKES.answer.scenarios[0], goalId: "g_missing" }] };
    const withPii = {
      ...BIKES.answer,
      audience: "Клиенты мастерской, вопросы — по телефону +7 916 123-45-67 или на почту master@example.test",
    };
    const { route, calls } = scripted([broken, withPii]);
    const r = await extractBriefDraft({ text: "ТЗ мастерской", route });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages)).toContain("g_missing");
    expect(r.method).toBe("model");
    expect(r.pii.found).toBe(2);
    expect(r.brief.audience).not.toMatch(/916|example\.test/);
    // V3-18: no scrub placeholder in the brief either — the neutral word of its kind (the site reads the brief).
    expect(r.brief.audience).toBe("Клиенты мастерской, вопросы — по телефону или на почту");
    expect(systemBriefSchema.safeParse(r.brief).success).toBe(true);
  });
});

describe("without a model: the heuristic draft", () => {
  test("no route, a model error or answers that never pass — goals and scenarios from headed lists", async () => {
    const { text } = await readBriefFile(sampleFile(COFFEE));
    const off = await extractBriefDraft({ text });
    expect(off).toMatchObject({ method: "heuristic", note: "модель не подключена", stats: { calls: 0 } });
    const failed = await extractBriefDraft({ text, route: scripted([new Error("LLM_UNAVAILABLE")]).route });
    expect(failed.method).toBe("heuristic");
    expect(failed.note).toMatch(/ошибка модели/);
    expect(failed.brief).toEqual(off.brief);
    const invalid = await extractBriefDraft({ text, route: scripted([{ goals: "нет" }]).route });
    expect(invalid).toMatchObject({ method: "heuristic", stats: { calls: 3 } });

    const b = off.brief;
    expect(b.goals.map((g) => g.text)).toEqual(COFFEE.sections[0]?.items);
    expect(b.goals.every((g) => g.success === BRIEF_DRAFT_TODO)).toBe(true);
    expect(b.scenarios.map((x) => [x.actor, x.when, x.then, x.priority])).toEqual([
      [
        "visitor",
        "Посетитель выбирает напитки и время",
        ["система принимает предзаказ и показывает номер заказа"],
        "should",
      ],
      ["staff", "Бариста отмечает заказ готовым", ["система присылает гостю уведомление на сайте"], "should"],
      ["visitor", "Меню с ценами и фото напитков", [BRIEF_DRAFT_TODO], "should"],
    ]);
    expect(b).toMatchObject({ audience: "", roles: [], data: [], integrations: [], outOfScope: [] });
    // Everything the heuristic took waits for the interview's confirmation.
    const gaps = briefGaps(b);
    expect(gaps.filled).toEqual([]);
    expect(gaps.blocking).toEqual(["goals", "audience", "scenarios"]);
  });

  test("plain text: «Цели:» and «Функции:» headings, numbered sections, a section without a list", () => {
    const b = heuristicDraft(PLAIN_TZ);
    expect(b.goals.map((g) => g.text)).toEqual([
      "Записывать гостей на мастер-классы",
      "Продавать подарочные сертификаты",
    ]);
    expect(b.scenarios.map((x) => [x.actor, x.when])).toEqual([
      ["client", "Гость выбирает мастер-класс и дату"],
      ["staff", "Администратор подтверждает бронь"],
    ]);
    const numbered = heuristicDraft(
      "1. Назначение системы\nСистема нужна, чтобы принимать заявки на ремонт.\n2. Требования к дизайну\n- Тёмная тема\n3. Функциональные требования\n1) Клиент оставляет заявку\n2) Менеджер звонит клиенту",
    );
    expect(numbered.goals.map((g) => g.text)).toEqual(["Система нужна, чтобы принимать заявки на ремонт."]);
    expect(numbered.scenarios.map((x) => [x.actor, x.when])).toEqual([
      ["client", "Клиент оставляет заявку"],
      ["staff", "Менеджер звонит клиенту"],
    ]);
    expect(heuristicDraft("Просто текст без заголовков и списков.")).toEqual(emptyBrief());
  });
});

describe("briefGaps", () => {
  test("an empty brief: every section missing, goals, audience and scenarios block the build", () => {
    const g = briefGaps(emptyBrief());
    expect(g.sections.map((s) => s.section)).toEqual([...BRIEF_GAP_SECTIONS]);
    expect(g.sections.map((s) => s.label)).toEqual([
      "Цели",
      "Аудитория",
      "Сценарии",
      "Данные",
      "Роли и доступы",
      "Интеграции",
      "Дизайн",
      "Не входит",
    ]);
    expect(g.missing).toEqual([...BRIEF_GAP_SECTIONS]);
    expect(g.blocking).toEqual(["goals", "audience", "scenarios"]);
    expect(g.filled).toEqual([]);
  });

  test("a full brief has no gaps; marks and missing parts make a section partial", () => {
    const full = systemBriefSchema.parse(dentalBrief());
    expect(briefGaps(full)).toMatchObject({ missing: [], blocking: [] });
    const partial = systemBriefSchema.parse({
      ...dentalBrief(),
      audience: `Пока ${BRIEF_DRAFT_TODO}`,
      scenarios: dentalBrief().scenarios?.map((s) => ({ ...s, priority: "should" })),
      roles: [{ id: "admin", name: "Администратор", can: [] }],
      data: [{ entity: "Заявка", fields: [], retention: "Уточнить в интервью" }],
    });
    const g = briefGaps(partial);
    expect(g.missing).toEqual(["audience", "scenarios", "data", "roles"]);
    const notes = Object.fromEntries(g.sections.map((s) => [s.section, s.notes]));
    expect(notes.scenarios?.[0]).toMatch(/Нет обязательных сценариев/);
    expect(notes.data).toEqual(["Не указаны поля данных «Заявка»", "Не указан срок хранения: «Заявка»"]);
    expect(notes.roles).toEqual(["Не указаны доступы ролей «Администратор»"]);
  });
});

describe("mergeBriefDraft: the draft fills only empty sections", () => {
  test("what the owner or the interview wrote stays; dangling goal references dropped", () => {
    const current = systemBriefSchema.parse({
      goals: [{ id: "g_own", text: "Своя цель владельца", success: "Своя метрика" }],
      audience: "Аудитория из интервью",
    });
    const draft = draftToBrief(COFFEE.answer);
    const m = mergeBriefDraft(current, draft);
    expect(m.goals).toEqual(current.goals);
    expect(m.audience).toBe("Аудитория из интервью");
    expect(m.roles).toEqual(draft.roles);
    expect(m.scenarios.map((s) => s.id)).toEqual(draft.scenarios.map((s) => s.id));
    expect(m.scenarios.every((s) => s.goalId === undefined)).toBe(true);
    expect(mergeBriefDraft(null, draft)).toEqual(draft);
    expect(systemBriefSchema.safeParse(m).success).toBe(true);
  });
});
