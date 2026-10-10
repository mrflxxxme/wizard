// V3-18: cabinet tables — filters by the status and the other enum/bool fields the role sees, search over the role's
// fields, «Выгрузить CSV» only in the owner's cabinet.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { cabinetPage, filterFields } from "../src/index.js";

const spec = {
  specVersion: "1",
  app: { name: "Студия", locale: "ru" },
  entities: [
    {
      name: "lead",
      label: "Заявка",
      fields: [
        { name: "name", label: "Имя", type: "string" },
        { name: "phone", label: "Телефон", type: "phone", pii: "basic" },
        { name: "source", label: "Источник", type: "enum", enum: [{ value: "site", label: "Сайт" }] },
        { name: "urgent", label: "Срочно", type: "bool" },
        {
          name: "status",
          label: "Статус",
          type: "enum",
          enum: [
            { value: "new", label: "Новая" },
            { value: "done", label: "Готово" },
          ],
        },
      ],
    },
  ],
  roles: [
    { name: "owner", label: "Владелец", access: "login", loginMethods: ["email_otp"], isAdmin: true },
    { name: "staff", label: "Сотрудник", access: "login", loginMethods: ["email_otp"] },
  ],
  permissions: [
    { role: "owner", entity: "lead", ops: ["read", "create", "update", "delete"] },
    { role: "staff", entity: "lead", ops: ["read", "update"], hiddenFields: ["source"] },
  ],
} as unknown as AppSpec;

describe("cabinet table (V3-18)", () => {
  test("filters: the status first, then the visible enum and bool fields", () => {
    expect(filterFields(spec, "owner", "lead")).toEqual(["status", "source", "urgent"]);
    expect(filterFields(spec, "staff", "lead")).toEqual(["status", "urgent"]);
  });

  test("the owner's table is searchable, filtered and exports CSV; a staff table does not export", () => {
    const owner = cabinetPage(spec, "owner", "Владелец", ["lead"]);
    expect(owner).toContain('searchable filters={["status","source","urgent"]} exportCsv onRowClick');
    const staff = cabinetPage(spec, "staff", "Сотрудник", ["lead"]);
    expect(staff).toContain('searchable filters={["status","urgent"]} onRowClick');
    expect(staff).not.toContain("exportCsv");
  });
});
