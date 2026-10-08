// V3-02 acceptance (builder-v3.md §3 C1): the brief schema with limits and Russian errors; briefDiff by fields (added,
// changed, removed, order); briefDiagrams — three graphs built by code, deterministic, never throwing on any input.
import { describe, expect, test } from "vitest";
import {
  BRIEF_FIELDS,
  BRIEF_LABEL_MAX,
  BRIEF_LIMITS,
  type BriefDiagrams,
  type BriefGraph,
  briefDiagrams,
  briefDiff,
  emptyBrief,
  type SystemBrief,
  type SystemBriefInput,
  systemBriefSchema,
  validateBrief,
} from "../src/index.js";
import { dentalBrief, minimalBrief, scenario, shopBrief } from "./brief-fixtures.js";

const parse = (b: SystemBriefInput): SystemBrief => systemBriefSchema.parse(b);
const CYRILLIC = /[а-яё]/i;

function errorsOf(input: unknown) {
  const r = validateBrief(input);
  if (r.ok) throw new Error("expected an invalid brief");
  for (const e of r.errors) expect(e.message_ru, e.path).toMatch(CYRILLIC);
  return r.errors;
}

describe("systemBriefSchema", () => {
  test("filled briefs are valid; defaults: priority must, empty lists, audience and references", () => {
    for (const b of [dentalBrief(), shopBrief()]) expect(validateBrief(b).ok).toBe(true);
    const dental = parse(dentalBrief());
    expect(dental.scenarios.map((s) => s.priority)).toEqual(["must", "must", "must", "should"]);
    expect(dental.roles[0]?.can).toEqual(["полный доступ"]);
    const min = parse(minimalBrief());
    expect(min).toEqual({
      goals: [],
      audience: "",
      scenarios: [],
      roles: [],
      data: [],
      integrations: [],
      design: { references: [] },
      outOfScope: [],
      assumptions: [],
      qa: [],
      capability: [],
    });
    expect(Object.keys(min)).toEqual([...BRIEF_FIELDS]);
    // Explicit empty arrays are the same brief.
    expect(
      parse({ goals: [], scenarios: [], roles: [], data: [], integrations: [], design: { references: [] } }),
    ).toEqual(min);
  });

  test("emptyBrief gives a fresh object every time; texts are trimmed", () => {
    const a = emptyBrief();
    a.goals.push({ id: "g", text: "Цель", success: "Успех" });
    a.design.references.push("x");
    expect(emptyBrief().goals).toEqual([]);
    expect(emptyBrief().design.references).toEqual([]);
    const b = parse({
      audience: "  Жители района  ",
      goals: [{ id: "g", text: " Цель ", success: "Успех" }],
    });
    expect(b.audience).toBe("Жители района");
    expect(b.goals[0]?.text).toBe("Цель");
  });

  test("unknown property, wrong enum, blank text: SCHEMA_INVALID with the place in Russian", () => {
    const unknown = errorsOf({ ...dentalBrief(), niche: "стоматология" });
    expect(unknown).toEqual([
      {
        code: "SCHEMA_INVALID",
        path: "/niche",
        message_ru: "Неизвестное свойство «niche»",
        hint: "Удалите свойство: в брифе такого поля нет",
      },
    ]);
    const actor = errorsOf({
      scenarios: [scenario({ id: "s", actor: "robot" as "system", when: "всегда" }, ["x"])],
    });
    expect(actor[0]).toMatchObject({
      code: "SCHEMA_INVALID",
      path: "/scenarios/0/actor",
      message_ru: "Сценарии, № 1, «Кто действует»: недопустимое значение",
    });
    expect(actor[0]?.allowed).toEqual(
      expect.arrayContaining(["visitor", "client", "staff", "owner", "system"]),
    );
    const blank = errorsOf({ goals: [{ id: "g", text: "   ", success: "Успех" }] });
    expect(blank[0]).toMatchObject({
      path: "/goals/0/text",
      message_ru: "Цели, № 1, «Текст»: слишком мало символов: минимум 1",
    });
    const noSteps = errorsOf({ scenarios: [scenario({ id: "s", actor: "visitor", when: "приходит" }, [])] });
    expect(noSteps[0]?.path).toBe("/scenarios/0/then");
    const missing = errorsOf({ data: [{ entity: "Клиент", fields: [] }] });
    expect(missing[0]).toMatchObject({
      path: "/data/0/retention",
      message_ru: "Данные, № 1, «Срок хранения»: обязательное свойство отсутствует",
    });
  });

  test("secrets only as secret://name; contract reference without spaces; ids are idents", () => {
    const key = errorsOf({
      integrations: [{ id: "tg", name: "Telegram", direction: "out", secretRef: "123:ABC" }],
    });
    expect(key[0]?.path).toBe("/integrations/0/secretRef");
    const ref = errorsOf({
      integrations: [{ id: "tg", name: "Telegram", direction: "in", contractRef: "мой контракт" }],
    });
    expect(ref[0]?.path).toBe("/integrations/0/contractRef");
    const id = errorsOf({ goals: [{ id: "Цель 1", text: "Цель", success: "Успех" }] });
    expect(id[0]).toMatchObject({ code: "SCHEMA_INVALID", path: "/goals/0/id" });
  });

  test("limits: lists and texts → LIMIT_EXCEEDED, the whole brief → TOO_LARGE", () => {
    const goals = Array.from({ length: BRIEF_LIMITS.goals + 1 }, (_, i) => ({
      id: `g${i}`,
      text: "Цель",
      success: "Успех",
    }));
    expect(errorsOf({ goals })).toEqual([
      { code: "LIMIT_EXCEEDED", path: "/goals", message_ru: "Цели: слишком много элементов: максимум 10" },
    ]);
    const long = errorsOf({
      scenarios: [scenario({ id: "s", actor: "visitor", when: "я".repeat(BRIEF_LIMITS.text + 1) }, ["x"])],
    });
    expect(long[0]).toMatchObject({
      code: "LIMIT_EXCEEDED",
      path: "/scenarios/0/when",
      message_ru: "Сценарии, № 1, «Когда»: слишком много символов: максимум 400",
    });
    const steps = errorsOf({
      scenarios: [scenario({ id: "s", actor: "visitor", when: "приходит" }, Array(13).fill("шаг"))],
    });
    expect(steps[0]).toMatchObject({ code: "LIMIT_EXCEEDED", path: "/scenarios/0/then" });
    // Every list within its limit, still too big as a whole (60 long answers in Cyrillic ≈ 300 KB).
    const qa = Array.from({ length: BRIEF_LIMITS.qa }, (_, i) => ({
      q: `Вопрос ${i} ${"в".repeat(BRIEF_LIMITS.question - 20)}`,
      a: "о".repeat(BRIEF_LIMITS.longText),
      recommended: "",
      chosen: "custom" as const,
    }));
    const big = errorsOf({ qa });
    expect(big).toHaveLength(1);
    expect(big[0]).toMatchObject({ code: "TOO_LARGE", path: "" });
    expect(big[0]?.message_ru).toMatch(/^Бриф слишком большой: \d+ КБ при лимите 256 КБ/);
  });

  test("unique ids, entities and fields; scenarios name only goals of the brief", () => {
    const b = dentalBrief();
    const dup = errorsOf({
      ...b,
      goals: [...(b.goals ?? []), { id: "g_leads", text: "Ещё цель", success: "Успех" }],
      roles: [...(b.roles ?? []), { id: "admin", name: "Второй админ" }],
      data: [
        ...(b.data ?? []),
        { entity: "клиент", fields: [], retention: "1 год" },
        { entity: "Отзыв", fields: [{ name: "Текст" }, { name: "текст" }], retention: "1 год" },
      ],
    });
    expect(dup.map((e) => [e.code, e.path])).toEqual([
      ["DUPLICATE_ID", "/goals/2/id"],
      ["DUPLICATE_ID", "/roles/2/id"],
      ["DUPLICATE_ID", "/data/3/entity"],
      ["DUPLICATE_ID", "/data/4/fields/1/name"],
    ]);
    expect(dup[0]?.message_ru).toBe("Id «g_leads» в разделе «Цели» повторяется");
    const ref = errorsOf({
      goals: [{ id: "g1", text: "Цель", success: "Успех" }],
      scenarios: [scenario({ id: "s", actor: "visitor", when: "приходит", goalId: "g2" }, ["встречает"])],
    });
    expect(ref).toEqual([
      {
        code: "UNKNOWN_REF",
        path: "/scenarios/0/goalId",
        message_ru: "Сценарий «s» ссылается на цель «g2», которой нет в брифе",
      },
    ]);
  });
});

describe("briefDiff", () => {
  const dental = parse(dentalBrief());

  test("first version: everything filled is added; equal briefs and a jsonb round trip give no changes", () => {
    const first = briefDiff(null, dental);
    expect(first.every((c) => c.op === "added")).toBe(true);
    expect(first.map((c) => c.field)).toEqual([
      "goals",
      "goals",
      "audience",
      ...Array(4).fill("scenarios"),
      "roles",
      "roles",
      ...Array(3).fill("data"),
      ...Array(3).fill("integrations"),
      ...Array(3).fill("design"),
      "outOfScope",
      "assumptions",
      "assumptions",
      "qa",
      "qa",
      ...Array(3).fill("capability"),
    ]);
    expect(first[0]).toMatchObject({
      key: "g_leads",
      text_ru: "Цели: добавлено «Получать записи на приём с сайта»",
    });
    expect(first.find((c) => c.field === "design" && c.prop === "archetype")).toMatchObject({
      op: "added",
      after: "warm_clinic",
    });
    expect(first.find((c) => c.field === "design" && c.prop === "pinned")).toMatchObject({
      op: "added",
      after: false,
    });
    expect(briefDiff(emptyBrief(), dental)).toEqual(first);
    expect(briefDiff(null, emptyBrief())).toEqual([]);
    expect(briefDiff(dental, structuredClone(dental))).toEqual([]);
    expect(briefDiff(dental, JSON.parse(JSON.stringify(dental)))).toEqual([]);
  });

  test("added, changed and removed by fields, in the order of the brief sections", () => {
    const next = structuredClone(dental);
    next.audience = "Жители района и соседних улиц";
    const goal = next.goals[1];
    if (goal) goal.success = "Неявок меньше 5 %";
    next.scenarios.push(
      parse({
        scenarios: [scenario({ id: "s_review", actor: "client", when: "после приёма" }, ["просит отзыв"])],
      }).scenarios[0] as SystemBrief["scenarios"][number],
    );
    const remind = next.scenarios.find((s) => s.id === "s_remind");
    if (remind) {
      remind.then.push("предлагает перенести запись");
      delete remind.goalId;
    }
    next.integrations = next.integrations.filter((x) => x.id !== "yookassa");
    next.design.references = [];
    next.design.pinned = true;
    const doctor = next.roles.find((r) => r.id === "doctor");
    if (doctor) doctor.name = "Врач-стоматолог";
    const diff = briefDiff(dental, next);
    expect(diff.map((c) => [c.field, c.key ?? null, c.prop ?? null, c.op])).toEqual([
      ["goals", "g_no_shows", "success", "changed"],
      ["audience", null, null, "changed"],
      ["scenarios", "s_remind", "then", "changed"],
      ["scenarios", "s_remind", "goalId", "removed"],
      ["scenarios", "s_review", null, "added"],
      ["roles", "doctor", "name", "changed"],
      ["integrations", "yookassa", null, "removed"],
      ["design", null, "pinned", "changed"],
      ["design", null, "references", "removed"],
    ]);
    expect(diff[0]).toMatchObject({
      before: "Неявок меньше 10 %",
      after: "Неявок меньше 5 %",
      text_ru: "Цели, «Меньше неявок»: изменено «Признак успеха»",
    });
    expect(diff[3]).toMatchObject({
      before: "g_no_shows",
      text_ru: "Сценарии, «Когда до приёма остаётся 24 часа»: удалено «Цель»",
    });
    expect(diff[3]).not.toHaveProperty("after");
    expect(diff[6]?.text_ru).toBe("Интеграции: удалено «ЮKassa»");
    for (const c of diff) expect(c.text_ru).toMatch(CYRILLIC);
  });

  test("reordering is one «order» change; data entities match regardless of case", () => {
    const next = structuredClone(dental);
    next.scenarios.reverse();
    const client = next.data[0];
    if (client) client.entity = "клиент";
    const diff = briefDiff(dental, next);
    expect(diff).toEqual([
      expect.objectContaining({
        field: "scenarios",
        prop: "order",
        op: "changed",
        text_ru: "Сценарии: изменён порядок",
      }),
      expect.objectContaining({
        field: "data",
        key: "клиент",
        prop: "entity",
        before: "Клиент",
        after: "клиент",
      }),
    ]);
    expect(diff[0]?.after).toEqual(["s_report", "s_confirm", "s_remind", "s_book"]);
  });

  test("text-keyed lists: a new text is added, the old removed; same text with a new value is changed", () => {
    const next = structuredClone(dental);
    const skip = next.assumptions[0];
    if (skip) skip.source = "default";
    next.outOfScope = [{ text: "Мобильное приложение для iOS" }];
    const qa = next.qa[1];
    if (qa) qa.a = "Да, за двое суток";
    const diff = briefDiff(dental, next);
    expect(diff.map((c) => [c.field, c.key, c.prop ?? null, c.op])).toEqual([
      ["outOfScope", "Мобильное приложение для iOS", null, "added"],
      ["outOfScope", "Мобильное приложение", null, "removed"],
      ["assumptions", "Оплата на месте, онлайн-оплата позже", "source", "changed"],
      ["qa", "Нужны напоминания?", "a", "changed"],
    ]);
  });
});

/** Shape invariants of a graph: unique node ids, edges between existing nodes, Russian one-line labels. */
function checkGraph(g: BriefGraph) {
  const ids = g.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(g.nodes.length).toBeGreaterThan(0);
  for (const n of g.nodes) {
    expect(typeof n.label).toBe("string");
    expect(n.label.length).toBeGreaterThan(0);
    expect(n.label.length).toBeLessThanOrEqual(BRIEF_LABEL_MAX);
    expect(n.label).not.toMatch(/\n/);
  }
  for (const e of g.edges) {
    expect(ids).toContain(e.from);
    expect(ids).toContain(e.to);
    expect(e.label).toMatch(CYRILLIC);
  }
}
const checkAll = (d: BriefDiagrams) => {
  expect(Object.keys(d)).toEqual(["journey", "dataRoles", "integrations"]);
  for (const g of Object.values(d)) checkGraph(g);
};

describe("briefDiagrams", () => {
  test("journey: actors, scenarios in brief order chained by «затем», goals they serve", () => {
    const { journey } = briefDiagrams(parse(dentalBrief()));
    checkGraph(journey);
    expect(journey.nodes.filter((n) => n.kind === "actor").map((n) => n.label)).toEqual([
      "Посетитель",
      "Сотрудник",
      "Владелец",
      "Система",
    ]);
    const scenarios = journey.nodes.filter((n) => n.kind === "scenario");
    expect(scenarios.map((n) => n.id)).toEqual([
      "scenario:s_book",
      "scenario:s_remind",
      "scenario:s_confirm",
      "scenario:s_report",
    ]);
    expect(scenarios[0]?.label).toBe(
      "Когда посетитель выбирает услугу и время, система: создаёт запись; присылает подтверждение в Telegram",
    );
    expect(scenarios[3]?.label).toMatch(/\(желательно\)$/);
    expect(journey.edges.filter((e) => e.label === "затем")).toHaveLength(3);
    expect(journey.edges).toContainEqual({
      from: "actor:system",
      to: "scenario:s_remind",
      label: "срабатывает",
    });
    expect(journey.edges).toContainEqual({
      from: "actor:visitor",
      to: "scenario:s_book",
      label: "действует",
    });
    expect(journey.edges).toContainEqual({ from: "scenario:s_book", to: "goal:g_leads", label: "цель" });
    expect(journey.nodes.filter((n) => n.kind === "goal")).toHaveLength(2);
  });

  test("data and roles: ПДн and retention on entities, access from the roles' texts", () => {
    const { dataRoles } = briefDiagrams(parse(dentalBrief()));
    checkGraph(dataRoles);
    const client = dataRoles.nodes.find((n) => n.label.startsWith("Клиент"));
    expect(client).toMatchObject({
      kind: "entity_pii",
      label: "Клиент · ПДн: Имя, Телефон · хранить: 3 года после последнего визита",
    });
    expect(dataRoles.nodes.filter((n) => n.kind === "entity")).toHaveLength(2);
    const byLabel = new Map(dataRoles.nodes.map((n) => [n.id, n.label]));
    const access = dataRoles.edges.map((e) => [
      byLabel.get(e.from),
      byLabel.get(e.to)?.split(" · ")[0],
      e.label,
    ]);
    expect(access).toEqual([
      ["Администратор", "Клиент", "полный доступ"],
      ["Администратор", "Запись", "полный доступ"],
      ["Администратор", "Услуга", "полный доступ"],
      ["Врач", "Запись", "видит свои записи"],
    ]);
  });

  test("integrations: the system in the middle, outgoing with contract and key state, incoming into it", () => {
    const { integrations } = briefDiagrams(parse(dentalBrief()));
    checkGraph(integrations);
    expect(integrations.nodes[0]).toEqual({ id: "system:self", label: "Ваша система", kind: "system" });
    expect(integrations.edges).toEqual([
      {
        from: "system:self",
        to: "integration:telegram",
        label: "исходящая · контракт не описан · ключ подключён",
      },
      {
        from: "system:self",
        to: "integration:yookassa",
        label: "исходящая · контракт описан · без ключа — работает на моке",
      },
      { from: "integration:crm_in", to: "system:self", label: "входящая · контракт описан" },
    ]);
  });

  test("deterministic: the same brief gives the same graphs, a copy too", () => {
    for (const make of [dentalBrief, shopBrief, minimalBrief]) {
      const b = parse(make());
      const once = briefDiagrams(b);
      checkAll(once);
      expect(briefDiagrams(structuredClone(b))).toEqual(once);
      expect(JSON.stringify(briefDiagrams(JSON.parse(JSON.stringify(b))))).toBe(JSON.stringify(once));
    }
  });

  test("minimal brief and empty lists: placeholder nodes, no edges", () => {
    for (const b of [parse(minimalBrief()), emptyBrief(), { ...emptyBrief(), design: { references: [] } }]) {
      const d = briefDiagrams(b);
      checkAll(d);
      expect(d.journey).toEqual({
        nodes: [{ id: "empty", label: "Сценарии пока не описаны", kind: "empty" }],
        edges: [],
      });
      expect(d.dataRoles.nodes).toEqual([
        { id: "empty", label: "Данные и роли пока не описаны", kind: "empty" },
      ]);
      expect(d.integrations.nodes.map((n) => [n.kind, n.label])).toEqual([
        ["system", "Ваша система"],
        ["empty", "Интеграций нет"],
      ]);
      expect(d.integrations.edges).toEqual([]);
    }
  });

  test("an invalid brief does not break the render", () => {
    const throwing = {
      get scenarios(): unknown {
        throw new Error("boom");
      },
      goals: [{ id: "g", text: "Цель", success: "Успех" }],
    };
    const garbage: unknown[] = [
      null,
      undefined,
      0,
      "бриф",
      [],
      [dentalBrief()],
      { goals: "много", scenarios: {}, roles: 5, data: null, integrations: "все" },
      {
        goals: [null, 1, { id: "../x y", text: 42 }, { id: "dup" }, { id: "dup" }],
        scenarios: [
          null,
          "Когда",
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          { when: 5, then: "строка", actor: "alien", goalId: { x: 1 } },
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          { id: "s", when: "x".repeat(5000), then: [null, 7, "шаг"], goalId: "dup" },
          { id: "s", actor: "visitor" },
        ],
      },
      {
        roles: [{ can: [1, null, "полный доступ"] }, { id: "r", name: "Роль", can: "всё" }],
        data: [{ fields: "x" }, {}],
      },
      { integrations: [{ direction: "sideways" }, null, { id: "a b", name: ["x"], direction: "in" }] },
      throwing,
      {
        scenarios: Array.from({ length: 2000 }, (_, i) => ({
          id: `s${i}`,
          actor: "visitor",
          when: "приходит",
        })),
      },
    ];
    for (const g of garbage) {
      let d: BriefDiagrams | undefined;
      expect(() => {
        d = briefDiagrams(g);
      }).not.toThrow();
      if (d) checkAll(d);
      for (const graph of Object.values(d ?? {})) expect(graph.nodes.length).toBeLessThanOrEqual(300);
    }
    // What can be read is still drawn: the second scenario keeps its steps and its goal link.
    const partial = briefDiagrams(garbage[7]);
    expect(partial.journey.nodes.find((n) => n.id === "scenario:s")?.label).toMatch(/^Когда x+…$/);
    expect(partial.journey.edges).toContainEqual({ from: "scenario:s", to: "goal:dup", label: "цель" });
    expect(briefDiagrams(throwing).journey.nodes).toEqual([
      { id: "empty", label: "Сценарии пока не описаны", kind: "empty" },
    ]);
  });
});
