// V3-03: tolerant reading of the interview tools before zod (no repair call for small slips of open models) and the
// brief merge by code — ids made, references to unknown goals and modules dropped, personal data fields marked, list
// items merged by id or main text, an invalid result reported to the model in Russian.
import { emptyBrief } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  applyBriefPatch,
  briefPatchSchema,
  normalizeBriefPatchArgs,
  normalizeDeferArgs,
  normalizeQuestionArgs,
  v3DeferInputSchema,
  v3QuestionInputSchema,
} from "../../src/interview-v3/index.js";

describe("tolerant reading", () => {
  test("a question: Russian topic, string options, no recommended mark, a reserved or invalid id, too many options", () => {
    const raw = {
      question: {
        topic: "Роли и доступы",
        question: "Кто ещё работает в системе?",
        why: "От этого зависят доступы.",
        options: [
          "Только я",
          { id: "delegate", label: "Решите за меня" },
          { id: "Админ", label: "Администратор" },
          "Мастера",
          "Все",
          "Ещё",
        ],
      },
    };
    const parsed = v3QuestionInputSchema.safeParse(normalizeQuestionArgs(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.topic).toBe("roles");
    expect(parsed.data.options.map((o) => [o.id, o.recommended])).toEqual([
      ["o1", true],
      ["o2", false],
      ["o3", false],
      ["o4", false],
      ["o5", false],
    ]);
    expect(parsed.data.recommendation).toBe("Подходит для начала, потом можно поменять в брифе.");
    expect(parsed.data.allowDelegate).toBe(true);
  });

  test("a question with two options stays invalid (3–5 buttons) — the model is asked to fix it", () => {
    const r = v3QuestionInputSchema.safeParse(
      normalizeQuestionArgs({ topic: "goals", text: "Что важнее?", whyItMatters: "x", options: ["А", "Б"] }),
    );
    expect(r.success).toBe(false);
  });

  test("a brief patch: wrapper, strings for lists, Russian actors and directions, no retention", () => {
    const out = normalizeBriefPatchArgs({
      patch: {
        goals: ["Получать заявки"],
        audience: ["Жители района", "Офисы рядом"],
        scenarios: [
          {
            actor: "Посетитель сайта",
            when: "оставляет заявку",
            // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
            then: "сохраняет заявку; сообщает владельцу",
            priority: "желательно",
          },
        ],
        roles: [{ name: "Администратор", can: "ведёт заявки; видит клиентов" }],
        data: [{ name: "Заявки", fields: "Имя; Телефон; Комментарий" }],
        integrations: ["Telegram", { name: "Сайт партнёра", direction: "входящая" }],
        outOfScope: ["Оплата на сайте"],
        assumptions: ["Работаем без выходных"],
        requirements: ["Доставка по городу"],
        facts: [{ text: "Без адреса", url: "не ссылка" }],
      },
    });
    const parsed = briefPatchSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const p = parsed.data;
    expect(p.goals?.[0]).toEqual({ text: "Получать заявки", success: "Признак успеха уточним с владельцем" });
    expect(p.audience).toBe("Жители района; Офисы рядом");
    expect(p.scenarios?.[0]).toMatchObject({
      actor: "visitor",
      // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
      then: ["сохраняет заявку", "сообщает владельцу"],
      priority: "should",
    });
    expect(p.roles?.[0]?.can).toEqual(["ведёт заявки", "видит клиентов"]);
    expect(p.data?.[0]).toMatchObject({
      entity: "Заявки",
      retention: "пока нужны для работы; удаляем по просьбе человека",
    });
    expect(p.integrations?.map((i) => i.direction)).toEqual(["out", "in"]);
    expect(p.facts).toEqual([]);
  });

  test("defer_question: Russian topic and the assumption under another key", () => {
    const r = v3DeferInputSchema.safeParse(
      normalizeDeferArgs({
        topic: "контент",
        question: "Какие фото на первом экране?",
        default: "Возьмём фото из стока",
      }),
    );
    expect(r.success && r.data).toEqual({
      topic: "content",
      text: "Какие фото на первом экране?",
      assumption: "Возьмём фото из стока",
    });
  });
});

describe("brief merge by code", () => {
  test("ids made, unknown goal and module references dropped, ПДн fields marked, items merged by main text", () => {
    const first = applyBriefPatch(
      emptyBrief(),
      {
        goals: [{ text: "Получать заявки", success: "Заявки не теряются" }],
        scenarios: [
          {
            actor: "visitor",
            when: "посетитель оставляет заявку",
            // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
            then: ["сохраняет её"],
            goalId: "nope",
            moduleHint: "leads",
            priority: "must",
          },
          {
            actor: "visitor",
            when: "посетитель смотрит цены",
            // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
            then: ["показывает прайс"],
            moduleHint: "marketplace",
            priority: "should",
          },
        ],
        roles: [
          { name: "Администратор", can: ["ведёт заявки"] },
          { name: "Бариста", can: [] },
        ],
        data: [
          {
            entity: "Заявки",
            fields: [{ name: "Имя клиента" }, { name: "Телефон" }, { name: "Комментарий" }],
            retention: "год",
          },
        ],
      },
      { assumptionSource: "default" },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const b = first.brief;
    expect(b.goals.map((g) => g.id)).toEqual(["g1"]);
    expect(b.scenarios.map((s) => [s.id, s.goalId ?? null, s.moduleHint ?? null])).toEqual([
      ["s1", null, "leads"],
      ["s2", null, null],
    ]);
    expect(b.roles.map((r) => r.id)).toEqual(["admin", "r1"]);
    expect(b.data[0]?.fields.map((f) => f.pii ?? false)).toEqual([true, true, false]);
    const second = applyBriefPatch(
      b,
      {
        goals: [{ text: "получать заявки", success: "Все заявки в одном месте" }],
        scenarios: [
          {
            actor: "visitor",
            when: "Посетитель оставляет заявку",
            // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
            then: ["сохраняет её", "пишет владельцу"],
            goalId: "g1",
            priority: "must",
          },
        ],
        assumptions: [{ text: "Работаем без выходных" }, { text: "работаем без выходных" }],
      },
      { assumptionSource: "owner_skip" },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.brief.goals).toEqual([
      { id: "g1", text: "получать заявки", success: "Все заявки в одном месте" },
    ]);
    expect(second.brief.scenarios.map((s) => [s.id, s.then.length, s.goalId])).toEqual([
      ["s1", 2, "g1"],
      ["s2", 1, undefined],
    ]);
    expect(second.brief.assumptions).toEqual([{ text: "Работаем без выходных", source: "owner_skip" }]);
  });

  test("an invalid result goes back to the model as Russian issues with the place", () => {
    const r = applyBriefPatch(
      emptyBrief(),
      { data: [{ entity: "Заявки", fields: [{ name: "Имя" }, { name: "имя" }], retention: "год" }] },
      { assumptionSource: "default" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ code: "DUPLICATE_ID" });
    expect(r.issues[0]?.message).toContain("повторяется");
  });

  test("personal data in the patch never reaches the brief", () => {
    const r = applyBriefPatch(
      emptyBrief(),
      { audience: "Клиенты, например Иванов Иван Иванович, тел. +7 917 123-45-67" },
      { assumptionSource: "default" },
    );
    expect(r.ok && r.brief.audience).not.toContain("123-45-67");
  });
});
