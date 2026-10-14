// V4-24: the facts a site of a business with a place cannot do without — asked by code within the cap: where to find
// it (address, phone, hours) and, when a scenario shows the specialists, who they are. The answers are kept in the
// brief (brief.qa) and read back: the site's facts (the contacts and the hours of the page prompt), the seed hints (the
// directions of the staff instead of «Услуга 1»). A shop online, or a brief that already says where it is, asks nothing.
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { dentalBrief } from "../../appspec/test/brief-fixtures.js";
import { seedHintsFromBrief } from "../src/builder/index.js";
import { siteFacts } from "../src/builder/v3/compose/index.js";
import {
  needsPlace,
  needsStaff,
  nextFactQuestion,
  PLACE_QUESTION_TEXT,
  placeFacts,
  STAFF_QUESTION_TEXT,
  staffFacts,
  v3QuestionInputSchema,
} from "../src/interview-v3/index.js";
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
});
