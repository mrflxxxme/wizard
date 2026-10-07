// B2-29 «ткни и скажи»: a picked block of the recorded plan «клиника» → hints and parameter toggles → PlanEdit[] of
// PATCH /plan (api.yaml#PlanEdit); the mock applies them like applyPlanEdits, so the board model changes.
import { describe, expect, test } from "vitest";
import type { PlanEdit, PlanSketch } from "../src/api/types.js";
import { type CanvasBlockModel, canvasModel } from "../src/screens/canvas/model.js";
import { blockActions } from "../src/screens/canvas/pick.js";
import { applyMockEdits, loadCanvasFeed } from "./mock/server.js";

const feed = loadCanvasFeed();
const sketch = feed.plan.sketch as unknown as PlanSketch;
const plan = feed.plan.plan;
const NAME = feed.system.name;
const model = canvasModel(sketch, NAME);
const all = [...model.frames.site, ...model.frames.phone, ...model.frames.cab];
const block = (id: string): CanvasBlockModel => {
  const b = all.find((x) => x.id === id);
  if (!b) throw new Error(`no block ${id}`);
  return b;
};
const ids = (h: { id: string }[]) => h.map((x) => x.id);
const apply = (edits: PlanEdit[]) =>
  applyMockEdits(plan, feed.plan.sketch, edits as unknown as Record<string, unknown>[]);

describe("block → edits", () => {
  test("hero: another ready variant, remove (with undo), down — not up past the header", () => {
    const a = blockActions(block("site:hero"), sketch, plan);
    expect(ids(a.hints)).toEqual(["view", "remove", "down"]);
    expect(a.variant).toEqual({ index: 1, of: 5 });
    expect(a.hints[0]?.edits).toEqual([{ op: "update_section", index: 1, variant: "centered" }]);
    expect(a.hints[0]?.label).toBe("Другой вид");
    expect(a.hints[1]?.edits).toEqual([{ op: "remove_section", index: 1 }]);
    expect(a.hints[1]?.undo).toEqual([
      {
        op: "add_section",
        type: "hero",
        variant: "split",
        content: expect.objectContaining({ title: "Спокойное лечение без очередей" }),
        at: 1,
      },
    ]);
    expect(a.hints[2]?.edits).toEqual([{ op: "move_section", from: 1, to: 2 }]);
    expect(a.params).toEqual([]);
  });

  test("the last section before the footer moves up only; the variant cycles back to the first", () => {
    const cta = block("site:cta");
    const a = blockActions(cta, sketch, plan);
    expect(ids(a.hints)).toEqual(["view", "remove", "up"]);
    expect(a.hints.find((h) => h.id === "up")?.edits).toEqual([{ op: "move_section", from: 4, to: 3 }]);
    const after = apply(a.hints[0]?.edits ?? []);
    const again = blockActions(cta, after.sketch as unknown as PlanSketch, after.plan);
    expect(again.variant).toEqual({ index: 2, of: 3 });
    const last = applyMockEdits(
      after.plan,
      after.sketch,
      (again.hints[0]?.edits ?? []) as unknown as Record<string, unknown>[],
    );
    const third = blockActions(cta, last.sketch as unknown as PlanSketch, last.plan);
    expect(third.variant).toEqual({ index: 3, of: 3 });
    expect(third.hints[0]?.edits).toEqual([{ op: "update_section", index: 4, variant: "band" }]);
  });

  test("services: a section drawn by the catalog — its switches next to the hints", () => {
    const a = blockActions(block("site:services"), sketch, plan);
    expect(ids(a.hints)).toEqual(["view", "remove", "up", "down"]);
    expect(a.params.map((p) => p.param)).toEqual([
      "show_prices",
      "with_duration",
      "with_categories",
      "with_photos",
    ]);
    const prices = a.params[0];
    expect(prices?.kind).toBe("bool");
    expect(prices?.options[0]).toMatchObject({ label: "Показывать цены", pressed: true });
    expect(prices?.options[0]?.edits).toEqual([
      { op: "set_param", module: "catalog", param: "show_prices", value: false },
    ]);
  });

  test("a module screen: remove the module, enum and enum_list toggles; long and text parameters stay in the chat", () => {
    const a = blockActions(block("cab:schedule"), sketch, plan);
    expect(ids(a.hints)).toEqual(["remove"]);
    expect(a.hints[0]?.edits).toEqual([{ op: "remove_module", module: "booking" }]);
    expect(a.variant).toBeNull();
    const names = a.params.map((p) => p.param);
    expect(names).toEqual([
      "workdays",
      "with_specialists",
      "confirm",
      "cancel_by_link",
      "reschedule_by_link",
    ]);
    const confirm = a.params.find((p) => p.param === "confirm");
    expect(confirm?.options.map((o) => [o.label, o.pressed])).toEqual([
      ["Сразу", true],
      ["Сотрудником", false],
    ]);
    expect(confirm?.options[1]?.edits).toEqual([
      { op: "set_param", module: "booking", param: "confirm", value: "manual" },
    ]);
    const days = a.params.find((p) => p.param === "workdays");
    expect(days?.options.find((o) => o.id === "sat")?.edits).toEqual([
      {
        op: "set_param",
        module: "booking",
        param: "workdays",
        value: ["mon", "tue", "wed", "thu", "fri", "sat"],
      },
    ]);
    expect(days?.options.find((o) => o.id === "mon")?.edits).toEqual([
      { op: "set_param", module: "booking", param: "workdays", value: ["tue", "wed", "thu", "fri"] },
    ]);
  });

  test("the whole site (nav, phone) is not removable; the nav offers the landing switches", () => {
    const nav = blockActions(block("site:nav"), sketch, plan);
    expect(nav.hints).toEqual([]);
    expect(nav.params.map((p) => p.param)).toEqual(["sticky_header", "anchor_nav"]);
    const mobile = blockActions(block("phone:mobile"), sketch, plan);
    expect(mobile).toEqual({ hints: [], params: [], variant: null });
  });

  test("nothing to edit on the interview sketch", () => {
    const interview = feed.interview.sketch as unknown as PlanSketch;
    const b = canvasModel(interview, NAME).frames.site[1] as CanvasBlockModel;
    expect(blockActions(b, interview)).toEqual({ hints: [], params: [], variant: null });
  });

  test("edits change the board: another view touches the block, remove drops it, move reorders, undo returns it", () => {
    const view = apply([{ op: "update_section", index: 2, variant: "cards" }]);
    const m1 = canvasModel(view.sketch as unknown as PlanSketch, NAME);
    expect(m1.frames.site.find((b) => b.id === "site:services")?.data.variant).toBe("cards");
    const removed = apply([{ op: "remove_section", index: 3 }]);
    const m2 = canvasModel(removed.sketch as unknown as PlanSketch, NAME);
    expect(m2.frames.site.some((b) => b.id === "site:steps")).toBe(false);
    const moved = apply([{ op: "move_section", from: 2, to: 3 }]);
    const m3 = canvasModel(moved.sketch as unknown as PlanSketch, NAME);
    expect(m3.frames.site.map((b) => b.kind).slice(1, 4)).toEqual(["hero", "steps", "services"]);
    const undo =
      blockActions(block("site:steps"), sketch, plan).hints.find((h) => h.id === "remove")?.undo ?? [];
    const back = applyMockEdits(removed.plan, removed.sketch, undo as unknown as Record<string, unknown>[]);
    expect(back.sketch.fingerprint).toBe(apply([{ op: "move_section", from: 1, to: 1 }]).sketch.fingerprint);
  });
});
