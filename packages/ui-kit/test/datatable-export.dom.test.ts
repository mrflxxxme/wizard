// @vitest-environment happy-dom
// V3-18: cabinet tables — CSV export (BOM, «;», labels, formula-safe cells, every page under the filter, only the
// role's visible fields), search over several fields in the memory source like the runtime `q` (phone by digits, hidden
// fields never match) and `can` with allowedValues.
import type { Field } from "@wizard/appspec";
import { createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { csvCell, csvValue, toCsv } from "../src/data/csv.js";
import { can, DataTable, toRoleSpec } from "../src/index.js";
import { createMemoryDataSource } from "../src/testing/index.js";
import { click, flush, type Rendered, render } from "./helpers/dom.js";

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
  vi.restoreAllMocks();
});
const ds = (userId: string | null) => {
  const f = forumFixture();
  return createMemoryDataSource(forum, f.rows, { users: f.users, functions: f.functions, userId });
};

describe("CSV", () => {
  const status: Field = {
    name: "status",
    label: "Статус",
    type: "enum",
    enum: [{ value: "new", label: "Новая" }],
  };
  test("BOM, «;», CRLF, enum labels, «Да»/«Нет», decimal commas, quoted cells", () => {
    const fields: Field[] = [
      { name: "name", label: "Имя; фамилия", type: "string" },
      status,
      { name: "vip", label: "VIP", type: "bool" },
      { name: "price", label: "Цена", type: "money" },
      { name: "day", label: "День", type: "date" },
    ];
    const text = toCsv(fields, [
      { id: "1", name: 'Анна "А"', status: "new", vip: true, price: 1500.5, day: "2026-10-09" },
      { id: "2", name: null, status: "other", vip: false, price: 0 },
    ]);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.slice(1).split("\r\n")).toEqual([
      '"Имя; фамилия";Статус;VIP;Цена;День',
      '"Анна ""А""";Новая;Да;1500,5;09.10.2026',
      ";other;Нет;0;",
      "",
    ]);
  });

  test("cells that start a formula are neutralised; phones and negative numbers stay", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("+7 (916) 123-45-67")).toBe("+7 (916) 123-45-67");
    expect(csvCell("-15,5")).toBe("-15,5");
    expect(csvValue(status, "new")).toBe("Новая");
  });
});

describe("memory search like the runtime q", () => {
  test("a phone by its digits in any notation, a name part; hidden fields never match", () => {
    const org = ds("u_organizer");
    const byPhone = org.list("speaker_application", { search: "8 (911) 000-00-05" });
    expect(byPhone.items.map((x) => x.id)).toEqual(["app_005"]);
    expect(org.list("speaker_application", { search: "опыт №7" }).items.map((x) => x.id)).toContain(
      "app_007",
    );
    // The moderator does not read the phone: the same query finds nothing.
    const mod = ds("u_moderator");
    expect(mod.list("speaker_application", { search: "8 (911) 000-00-05" }).total).toBe(0);
  });
});

describe("can with allowedValues", () => {
  test("a listed value passes, another does not; no value — the field is writable", () => {
    const spec = structuredClone(forum);
    for (const p of spec.permissions)
      if (p.role === "moderator" && p.entity === "speaker_application")
        p.allowedValues = { status: ["rejected"] };
    const rs = toRoleSpec(spec, "moderator");
    expect(can(rs, "update", "speaker_application", "status", "rejected")).toBe(true);
    expect(can(rs, "update", "speaker_application", "status", "approved")).toBe(false);
    expect(can(rs, "update", "speaker_application", "status")).toBe(true);
  });
});

describe("DataTable exportCsv", () => {
  async function exported(role: string, filter: Record<string, unknown> = {}): Promise<string[]> {
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blob = b as Blob;
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    r = await render(
      h(DataTable, { entity: "speaker_application", exportCsv: true, query: { filter }, pageSize: 25 }),
      { app: forum, role, ds: ds(`u_${role}`) },
    );
    await flush(10);
    expect(r.$$("wz-datatable-row").length).toBeGreaterThan(0);
    await click(r.$("wz-datatable-export"));
    for (let i = 0; i < 50 && !blob; i++) await flush(10);
    expect(anchor).toHaveBeenCalledTimes(1);
    const text = await (blob as Blob).text();
    expect(text.startsWith("﻿")).toBe(true);
    return text.slice(1).trimEnd().split("\r\n");
  }

  test("every page under the filter, not just the 25 shown", async () => {
    const lines = await exported("organizer", { status: "approved" });
    expect(lines).toHaveLength(21);
    expect(lines[0]?.split(";")).toContain("Телефон");
    expect(lines.slice(1).every((l) => l.includes(";Одобрена;"))).toBe(true);
  });

  test("a role that does not read the phone gets no phone column", async () => {
    const lines = await exported("moderator");
    expect(r?.$$("wz-datatable-row")).toHaveLength(25);
    expect(lines).toHaveLength(61);
    expect(lines[0]?.split(";")).not.toContain("Телефон");
    expect(lines.join("\n")).not.toMatch(/\+7911/);
  });
});
