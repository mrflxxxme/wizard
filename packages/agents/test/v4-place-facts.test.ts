// V4-24: the facts a site of a business with a place cannot do without — asked by code within the cap: where to find
// it (address, phone, hours) and, when a scenario shows the specialists, who they are. The answers are kept in the
// brief (brief.qa) and read back: the site's facts (the contacts and the hours of the page prompt), the seed hints (the
// directions of the staff instead of «Услуга 1»). A shop online, or a brief that already says where it is, asks nothing.
import { emptyBrief, type SystemBrief, systemBriefSchema, validateBrief } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { dentalBrief } from "../../appspec/test/brief-fixtures.js";
import { seedHintsFromBrief } from "../src/builder/index.js";
import { siteFacts } from "../src/builder/v3/compose/index.js";
import {
  addQa,
  createInterviewV3,
  needsPlace,
  needsPrices,
  needsStaff,
  newInterviewV3Session,
  nextFactQuestion,
  PLACE_QUESTION_TEXT,
  PRICE_QUESTION_TEXT,
  placeFacts,
  priceFacts,
  STAFF_QUESTION_TEXT,
  staffFacts,
  staffQuestion,
  v3QuestionInputSchema,
} from "../src/interview-v3/index.js";
import { scriptedRoute } from "./interview-v3/helpers.js";
import { briefSite } from "./v3-brief-site.js";
import { composeContext } from "./v3-compose-fixtures.js";
import { DENTAL_BOOKING } from "./v3-eval-briefs.js";

const qa = (q: string, a: string, chosen: "custom" | "recommended" = "custom") => ({
  q,
  a,
  recommended: "x",
  chosen,
});
const withQa = (b: SystemBrief, ...items: ReturnType<typeof qa>[]): SystemBrief => ({
  ...b,
  qa: [...b.qa, ...items],
});
const DENTAL = systemBriefSchema.parse(dentalBrief());
/** The spec with an entity of the specialists (name and description), as a booking with specialists has. */
function specialistsSpec<T extends { entities: { name: string }[] }>(spec: T): T {
  return {
    ...spec,
    entities: [
      ...spec.entities.filter((e) => e.name !== "specialist"),
      {
        name: "specialist",
        label: "Врач",
        fields: [
          { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
          { name: "description", label: "Описание", type: "text", maxLength: 1000 },
        ],
      },
    ],
  } as T;
}
const CLINIC = "Стоматологическая клиника в Казани, запись к врачам онлайн";

describe("V4-24 fact questions", () => {
  test("a clinic is a place: where to find it is asked; once answered, or already said, it is not", () => {
    expect(needsPlace(DENTAL, CLINIC)).toBe(true);
    expect(nextFactQuestion(DENTAL, CLINIC)?.kind).toBe("place");
    expect(needsPlace(withQa(DENTAL, qa(PLACE_QUESTION_TEXT, "Добавлю потом", "recommended")), CLINIC)).toBe(
      false,
    );
    expect(needsPlace(DENTAL, `${CLINIC}. Мы на ул. Баумана, 12`)).toBe(false);
    expect(needsPlace(DENTAL, `${CLINIC}, звоните +7 843 210-45-67`)).toBe(false);
  });

  test("an online shop has no place to come to", () => {
    const shop = systemBriefSchema.parse({
      goals: [{ id: "g1", text: "Продажи чая онлайн", success: "50 заказов в месяц" }],
      audience: "Любители чая по всей России",
    });
    expect(needsPlace(shop, "Интернет-магазин чая с доставкой по России")).toBe(false);
  });

  test("specialists: asked when a public scenario shows them and the brief does not list them", () => {
    const shows = systemBriefSchema.parse({
      ...dentalBrief(),
      scenarios: [
        {
          id: "s_doctors",
          actor: "visitor",
          when: "пациент выбирает врача",
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          then: ["показывает врачей и их специализацию"],
        },
      ],
    });
    expect(needsStaff(DENTAL, CLINIC)).toBe(false);
    expect(needsStaff(shows, CLINIC)).toBe(true);
    expect(needsStaff(shows, `${CLINIC}. Врачи: терапевт, хирург`)).toBe(false);
    // The place first, then the specialists.
    expect(nextFactQuestion(shows, CLINIC)?.kind).toBe("place");
    const placed = withQa(shows, qa(PLACE_QUESTION_TEXT, "Казань, ул. Баумана, 12"));
    expect(nextFactQuestion(placed, CLINIC)?.kind).toBe("staff");
    expect(
      nextFactQuestion(withQa(placed, qa(STAFF_QUESTION_TEXT, "Пропустить", "recommended")), CLINIC),
    ).toBeNull();
  });

  test("both questions pass the question schema: 3 options, one recommended, «Решите за меня»", () => {
    const shows = systemBriefSchema.parse({
      ...dentalBrief(),
      scenarios: [
        // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
        { id: "s1", actor: "visitor", when: "пациент открывает сайт", then: ["видит врачей"] },
      ],
    });
    for (const b of [DENTAL, withQa(shows, qa(PLACE_QUESTION_TEXT, "Казань"))]) {
      const q = nextFactQuestion(b, CLINIC)?.question;
      expect(v3QuestionInputSchema.safeParse(q).success).toBe(true);
      expect(q?.allowDelegate).toBe(true);
    }
  });

  test("the answers as the owner wrote them: address, phone, hours; the specialists one by one; a button is no fact", () => {
    const b = withQa(
      DENTAL,
      qa(PLACE_QUESTION_TEXT, "Адрес: Казань, ул. Баумана, 12; телефон +7 (843) 210-45-67; пн–пт 9:00–20:00"),
      qa(STAFF_QUESTION_TEXT, "Анна Смирнова — терапевт, Игорь Ким — хирург; Ольга Петрова — ортодонт"),
    );
    expect(placeFacts(b)).toEqual({
      address: "Казань, ул. Баумана, 12",
      phone: "+7 (843) 210-45-67",
      hours: "пн–пт 9:00–20:00",
    });
    expect(staffFacts(b)).toEqual([
      "Анна Смирнова — терапевт",
      "Игорь Ким — хирург",
      "Ольга Петрова — ортодонт",
    ]);
    const buttons = withQa(
      DENTAL,
      qa(PLACE_QUESTION_TEXT, "Добавлю потом — пока без контактов", "recommended"),
    );
    expect(placeFacts(buttons)).toEqual({});
  });

  test("the site's facts: the operator's data first, else the place the owner gave; the hours for the page prompt", () => {
    const ctx = composeContext();
    const place = qa(PLACE_QUESTION_TEXT, "Казань, ул. Пушкина, 3; ежедневно 10:00–22:00; +7 843 555-12-34");
    // The operator's address and contact stay first.
    const withOperator = siteFacts({ ...ctx, brief: withQa(ctx.brief, place) });
    expect(withOperator.address).toBe("Казань, ул. Баумана, 15");
    expect(withOperator.hours).toBe("ежедневно 10:00–22:00");
    // No operator's data: the interview's answer.
    const bare = {
      ...ctx.spec,
      compliance: { ...ctx.spec.compliance, operatorAddress: undefined, operatorContact: undefined },
    };
    const f = siteFacts({ ...ctx, spec: bare as never, brief: withQa(ctx.brief, place) });
    expect(f.address).toBe("Казань, ул. Пушкина, 3");
    // D79 (3): the business phone of the place answer reaches the site (kept unscrubbed by the interview).
    expect(f.phone).toBe("+7 843 555-12-34");
    expect(withOperator.phone).toBe("+7 843 200-40-50");
  });

  test("the seed hints: the directions of the specialists the owner named, not «Услуга 1»", async () => {
    const { spec } = await briefSite("v4-23-dental", DENTAL_BOOKING);
    const brief = systemBriefSchema.parse(DENTAL_BOOKING);
    expect(seedHintsFromBrief(spec, brief)).toEqual([]);
    const named = withQa(brief, qa(STAFF_QUESTION_TEXT, "Анна Смирнова — терапевт, Игорь Ким — хирург"));
    expect(seedHintsFromBrief(spec, named)).toEqual([
      { entity: "service", field: "name", values: ["Терапия", "Хирургия"] },
    ]);
  });

  test("D79 (3): the specialists the owner named — demo rows of the booking's specialists and a line of the page's facts", async () => {
    const { spec } = await briefSite("v4-24-staff", DENTAL_BOOKING);
    const withSpecialists = specialistsSpec(spec);
    const brief = withQa(
      systemBriefSchema.parse(DENTAL_BOOKING),
      qa(STAFF_QUESTION_TEXT, "Анна Смирнова — терапевт, Игорь Ким — хирург"),
    );
    const hints = seedHintsFromBrief(withSpecialists, brief);
    expect(hints.filter((h) => h.entity === "specialist")).toEqual([
      { entity: "specialist", field: "name", values: ["Анна Смирнова", "Игорь Ким"], source: "owner" },
      { entity: "specialist", field: "description", values: ["Терапевт", "Хирург"] },
    ]);
    // No specialists' entity — no rows of them; the directions stay the offer as before.
    expect(seedHintsFromBrief(spec, brief).some((h) => h.entity === "specialist")).toBe(false);
    // The page's facts carry them as written; no answer — no line, no section of them.
    const ctx = composeContext();
    const f = siteFacts({
      ...ctx,
      brief: withQa(ctx.brief, qa(STAFF_QUESTION_TEXT, "Анна Смирнова — терапевт")),
    });
    expect(f.staff).toEqual(["Анна Смирнова — терапевт"]);
    expect(siteFacts(ctx).staff).toBeUndefined();
  });

  test("prices «от»: asked of a business with services after the place; not of a shop, nor when the brief names a price", () => {
    const placed = withQa(DENTAL, qa(PLACE_QUESTION_TEXT, "Казань, ул. Баумана, 12"));
    expect(needsPrices(placed, CLINIC)).toBe(true);
    expect(nextFactQuestion(placed, CLINIC)?.kind).toBe("prices");
    expect(v3QuestionInputSchema.safeParse(nextFactQuestion(placed, CLINIC)?.question).success).toBe(true);
    expect(needsPrices(placed, `${CLINIC}, чистка от 4000 ₽`)).toBe(false);
    expect(
      needsPrices(
        withQa(placed, qa(PRICE_QUESTION_TEXT, "Добавлю потом — пока без цен", "recommended")),
        CLINIC,
      ),
    ).toBe(false);
    const shop = systemBriefSchema.parse({
      goals: [{ id: "g1", text: "Продажи чая", success: "50 заказов в месяц" }],
      audience: "Любители чая",
      scenarios: [
        {
          id: "s1",
          actor: "visitor",
          when: "покупатель смотрит каталог",
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          then: ["кладёт товар в корзину"],
          moduleHint: "catalog",
        },
      ],
    });
    expect(needsPrices(shop, "Чайная лавка в Казани")).toBe(false);
  });

  test("the prices as the owner wrote them: «— от 3 500 ₽», «: 4000 руб», a bare number; a button is no fact", () => {
    const b = withQa(
      DENTAL,
      qa(
        PRICE_QUESTION_TEXT,
        "Лечение кариеса — от 3 500 ₽; Профессиональная чистка: 4000 руб\nИмплантация от 35000, Консультация 0",
      ),
    );
    expect(priceFacts(b)).toEqual([
      { name: "Лечение кариеса", price: 3500 },
      { name: "Профессиональная чистка", price: 4000 },
      { name: "Имплантация", price: 35000 },
    ]);
    expect(priceFacts(withQa(DENTAL, qa(PRICE_QUESTION_TEXT, "Цены по запросу", "recommended")))).toEqual([]);
  });

  test("the prices in the seed hints (the owner's services first, by name) and in the site's facts", async () => {
    const { spec } = await briefSite("v4-24-prices", DENTAL_BOOKING);
    const brief = systemBriefSchema.parse(DENTAL_BOOKING);
    const priced = withQa(brief, qa(PRICE_QUESTION_TEXT, "Лечение кариеса — от 3500; Чистка — 4000"));
    expect(seedHintsFromBrief(spec, priced)).toEqual([
      { entity: "service", field: "name", values: ["Лечение кариеса", "Чистка"] },
      { entity: "service", field: "price", values: [3500, 4000] },
    ]);
    // A price the seed cannot take (not whole hundreds) leaves its service without a price, after the priced ones.
    const odd = withQa(brief, qa(PRICE_QUESTION_TEXT, "Консультация — 750; Чистка — 4000"));
    expect(seedHintsFromBrief(spec, odd)).toEqual([
      { entity: "service", field: "name", values: ["Чистка", "Консультация"] },
      { entity: "service", field: "price", values: [4000] },
    ]);
    // With a list of services in the brief: the priced ones first in the list's spelling, the rest after them.
    const listed = withQa(
      withQa(brief, qa(STAFF_QUESTION_TEXT, "Анна Смирнова — терапевт, Игорь Ким — хирург")),
      qa(PRICE_QUESTION_TEXT, "хирургия — от 5000"),
    );
    expect(seedHintsFromBrief(spec, listed)).toEqual([
      { entity: "service", field: "name", values: ["Хирургия", "Терапия"] },
      { entity: "service", field: "price", values: [5000] },
    ]);
    const ctx = composeContext();
    expect(siteFacts(ctx).prices).toBe(false);
    expect(
      siteFacts({ ...ctx, brief: withQa(ctx.brief, qa(PRICE_QUESTION_TEXT, "Чистка — 4000")) }).prices,
    ).toBe(true);
  });
});

describe("D79 (3): the specialists' names of the owner's answer are kept, the rest is scrubbed", () => {
  const SALON = "Салон красоты в Казани: стрижки, окрашивание, маникюр, запись к мастерам онлайн";

  /** The owner answers the staff question in the interview (by code, no model call); the brief after the answer. */
  async function answerStaff(text: string): Promise<SystemBrief> {
    const { route, inputs } = scriptedRoute([new Error("no model call on a fact answer")]);
    const iv = createInterviewV3({
      route,
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "org" },
      research: null,
      emit: async () => {},
    });
    const { patches, ...q } = staffQuestion();
    const s = {
      ...newInterviewV3Session(),
      state: "asking" as const,
      prompt: SALON,
      brief: withQa(
        systemBriefSchema.parse(DENTAL_BOOKING),
        qa(PLACE_QUESTION_TEXT, "Казань, ул. Баумана, 12"),
      ),
      asked: 3,
      current: { ...q, id: "q4", step: 4, source: "fallback" as const, patches },
    };
    const res = await iv.answer(s, { questionId: "q4", text });
    expect(inputs).toHaveLength(0);
    expect(validateBrief(res.session.brief).ok).toBe(true);
    return res.session.brief;
  }

  test("the answer → brief.qa → staffFacts → the specialists' demo rows: the names as the owner wrote them", async () => {
    const brief = await answerStaff("Анна Петрова — стилист-колорист, Мария — мастер маникюра");
    expect(brief.qa.find((x) => x.q === STAFF_QUESTION_TEXT)?.a).toBe(
      "Анна Петрова — стилист-колорист, Мария — мастер маникюра",
    );
    expect(staffFacts(brief)).toEqual(["Анна Петрова — стилист-колорист", "Мария — мастер маникюра"]);
    const { spec } = await briefSite("v4-24-staff", DENTAL_BOOKING);
    expect(seedHintsFromBrief(specialistsSpec(spec), brief).filter((h) => h.entity === "specialist")).toEqual(
      [
        { entity: "specialist", field: "name", values: ["Анна Петрова", "Мария"], source: "owner" },
        { entity: "specialist", field: "description", values: ["Стилист-колорист", "Мастер маникюра"] },
      ],
    );
  });

  test("a phone, an e-mail and a passport in the same answer are scrubbed; the names stay", async () => {
    const brief = await answerStaff(
      "Анна Петрова — стилист-колорист, Мария — мастер маникюра; запись +7 999 123-45-67, anna.petrova@salon.ru; паспорт 4510 123456",
    );
    const a = brief.qa.find((x) => x.q === STAFF_QUESTION_TEXT)?.a ?? "";
    expect(a).toContain("Анна Петрова — стилист-колорист");
    expect(a).toContain("Мария — мастер маникюра");
    expect(a).not.toMatch(/999|123-45-67|@salon|anna\.petrova|4510|123456/);
    expect(staffFacts(brief).slice(0, 2)).toEqual([
      "Анна Петрова — стилист-колорист",
      "Мария — мастер маникюра",
    ]);
  });

  test("only that answer: the names in any other answer are scrubbed as before", () => {
    const b = emptyBrief();
    addQa(b, {
      q: "Кто ведёт запись?",
      a: "Анна Петрова — администратор",
      recommended: "x",
      chosen: "custom",
    });
    expect(b.qa[0]?.a).not.toContain("Анна");
  });
});
