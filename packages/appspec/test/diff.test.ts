// M1-04: diffSpecs — human diff of two revisions (api.yaml getRevisionDiff).
import { describe, expect, test } from "vitest";
import { type AppSpec, applyOps, diffSpecs } from "../src/index.js";
import { forumSpec } from "./helpers.js";

function next(spec: AppSpec, ops: unknown[]): AppSpec {
  const r = applyOps(spec, ops, 0, { author: "user" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const texts = (spec: AppSpec, after: AppSpec) => diffSpecs(spec, after).map((c) => c.text_ru);

describe("diffSpecs", () => {
  const forum = forumSpec();

  test("identical specs → no changes; null → everything is added", () => {
    expect(diffSpecs(forum, structuredClone(forum))).toEqual([]);
    const all = diffSpecs(null, forum);
    expect(all.filter((c) => c.kind === "entity")).toHaveLength(forum.entities.length);
    expect(all.some((c) => c.destructive)).toBe(false);
    expect(all.find((c) => c.kind === "role")?.text_ru).toMatch(/^Добавлена роль «/);
  });

  test("added optional field is additive and named by labels", () => {
    const after = next(forum, [
      { op: "add_field", entity: "stream", field: { name: "hall", label: "Зал", type: "string" } },
    ]);
    const changes = diffSpecs(forum, after);
    expect(changes).toEqual([{ kind: "field", text_ru: "В «Поток» добавлено поле «Зал» (строка)" }]);
  });

  test("removal, type change and new NOT NULL are destructive", () => {
    const after = next(forum, [
      { op: "remove_field", entity: "stream", name: "description" },
      { op: "update_field", entity: "stream", name: "capacity", patch: { label: "Вместимость зала" } },
    ]);
    const c = diffSpecs(forum, after);
    expect(c.find((x) => x.text_ru.startsWith("Из «Поток» удалено поле"))?.destructive).toBe(true);
    expect(c.find((x) => x.text_ru.includes("изменено поле"))?.text_ru).toContain("название");

    const retyped = structuredClone(forum);
    const f = retyped.entities[0]?.fields.find((x) => x.name === "capacity");
    if (f) f.type = "string";
    expect(diffSpecs(forum, retyped).find((x) => x.kind === "field")).toMatchObject({ destructive: true });

    const required = structuredClone(forum);
    const d = required.entities[0]?.fields.find((x) => x.name === "description");
    if (d) d.required = true;
    expect(diffSpecs(forum, required)[0]).toMatchObject({ kind: "field", destructive: true });

    const noEntity = structuredClone(forum);
    noEntity.entities = noEntity.entities.filter((e) => e.name !== "payment");
    noEntity.permissions = noEntity.permissions.filter((p) => p.entity !== "payment");
    const lines = diffSpecs(forum, noEntity);
    expect(lines[0]).toMatchObject({ kind: "entity", destructive: true });
    expect(lines.filter((l) => l.kind === "permission").length).toBeGreaterThan(0);
  });

  test("permissions, pages, theme and compliance lines are Russian and value-free", () => {
    const after = structuredClone(forum);
    after.theme = { ...(after.theme ?? {}), accent: "#0A7D3E" };
    after.pages = (after.pages ?? []).filter((p) => p.route !== "/scanner");
    after.compliance = { ...(after.compliance ?? {}), operatorName: "ООО «Тест»" };
    const perm = after.permissions.find((p) => p.role === "organizer");
    if (perm) perm.ops = ["read"];
    const t = texts(forum, after);
    expect(t).toContain("Изменён стиль");
    expect(t).toContain("Удалён экран «Сканер билетов»");
    expect(t).toContain("Обновлены сведения об операторе ПДн");
    expect(t.some((x) => x.startsWith("Изменены права «Организатор»"))).toBe(true);
    expect(t.join("\n")).not.toContain("ООО «Тест»");
  });
});
