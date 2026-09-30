import { describe, expect, test } from "vitest";
import { v } from "../src/index.js";
import { validateArgs } from "../src/validators.js";

const id = "00000001-0000-4000-8000-000000000000";

describe("v validators", () => {
  const shape = {
    ticketTypeId: v.id("ticket_type" as never),
    holderName: v.string({ min: 2, max: 5 }),
    email: v.email(),
    phone: v.optional(v.phone()),
    qty: v.int({ min: 1, max: 3 }),
    price: v.money(),
    ok: v.boolean(),
    day: v.date(),
    at: v.datetime(),
    kind: v.enum("a", "b"),
    one: v.literal(1),
    list: v.array(v.string(), { max: 2 }),
    obj: v.object({ x: v.number(), y: v.optional(v.string()) }),
    note: v.nullable(v.string()),
    page: v.pagination(),
  };
  const good = {
    ticketTypeId: id,
    holderName: "Анна",
    email: "a@b.ru",
    qty: 2,
    price: 10.5,
    ok: true,
    day: "2026-11-14",
    at: "2026-11-14T06:30:00.000Z",
    kind: "a",
    one: 1,
    list: ["x"],
    obj: { x: 1.5 },
    note: null,
    page: { cursor: null, numItems: 10 },
  };

  test("accepts valid args", () => {
    expect(validateArgs(shape, good)).toEqual([]);
    expect(validateArgs(shape, { ...good, phone: "+7 999 000-00-00" })).toEqual([]);
  });

  test("reports each violation with field path and code", () => {
    const bad = {
      ...good,
      ticketTypeId: "abc",
      holderName: "Анна Каренина",
      email: "nope",
      phone: "x",
      qty: 1.5,
      price: 1.234,
      ok: "yes",
      day: "14.11.2026",
      at: "yesterday",
      kind: "c",
      one: 2,
      list: ["a", "b", 3],
      obj: { x: "1", z: 1 },
      page: { cursor: 5, numItems: 0 },
      extra: true,
    };
    const issues = validateArgs(shape, bad);
    const byField = Object.fromEntries(issues.map((i) => [i.field, i.code]));
    expect(byField).toMatchObject({
      ticketTypeId: "id",
      holderName: "too_long",
      email: "email",
      phone: "phone",
      qty: "int",
      price: "money",
      ok: "type",
      day: "date",
      at: "datetime",
      kind: "enum",
      one: "literal",
      list: "too_big",
      "list[2]": "type",
      "obj.x": "type",
      "obj.z": "unknown",
      "page.cursor": "type",
      "page.numItems": "type",
      extra: "unknown",
    });
    expect(issues.every((i) => i.message.length > 0)).toBe(true);
  });

  test("missing required and optional handling", () => {
    const issues = validateArgs({ a: v.string(), b: v.optional(v.string()), c: v.nullable(v.string()) }, {});
    expect(issues.map((i) => [i.field, i.code])).toEqual([
      ["a", "required"],
      ["c", "required"],
    ]);
    expect(v.optional(v.string()).isOptional).toBe(true);
    expect(v.string().kind).toBe("string");
  });
});
