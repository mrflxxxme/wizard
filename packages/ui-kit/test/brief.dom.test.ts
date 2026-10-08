// @vitest-environment happy-dom
// V3-06 (DOM): behaviour of the «Бриф» components — the short brief (theses, thumbnails open the panel), the panel
// (tabs by keyboard, what the latest version changed is marked, versions with their difference, sessions open a
// version), the editor (a valid edit goes to onSave with baseVersion, an invalid one explains itself, links to removed
// goals are cleared) and the session feed.
import { briefDiagrams, briefDiff, type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dentalBrief, scenario } from "../../appspec/test/brief-fixtures.js";
import {
  BriefEditor,
  BriefPanel,
  type BriefSession,
  BriefSummary,
  type BriefVersionInfo,
  SessionsFeed,
} from "../src/v2/index.js";
import { click, render, type } from "./helpers/dom.js";

const parse = (b: unknown): SystemBrief => systemBriefSchema.parse(b);
const v1 = parse(dentalBrief());
const v2 = parse({
  ...v1,
  scenarios: [
    ...v1.scenarios,
    scenario({ id: "s_review", actor: "client", when: "клиент оставляет отзыв" }, ["публикует отзыв"]),
  ],
  audience: "Жители района",
});
const versions: BriefVersionInfo[] = [
  { version: 2, diff: briefDiff(v1, v2), author: "owner", createdAt: "2026-10-08T10:00:00Z" },
  { version: 1, diff: briefDiff(null, v1), author: "agent", createdAt: "2026-10-08T09:00:00Z" },
];
const sessions: BriefSession[] = [
  {
    id: "brief:2",
    kind: "edit",
    source: "panel",
    status: "done",
    startedAt: "2026-10-08T10:00:00Z",
    briefVersions: [2],
    changes: ["Аудитория: изменено"],
    changesTotal: 2,
  },
  {
    id: "build:x",
    kind: "build",
    status: "failed",
    startedAt: "2026-10-08T09:30:00Z",
    finishedAt: "2026-10-08T09:42:00Z",
    build: { mode: "change", revision: null, failure: "Кончилось время" },
  },
  {
    id: "interview:y",
    kind: "interview",
    status: "done",
    startedAt: "2026-10-08T09:00:00Z",
    briefVersions: [1],
  },
];

afterEach(() => {
  document.body.innerHTML = "";
});

const panel = (over: Record<string, unknown> = {}) =>
  h(BriefPanel, {
    brief: v2,
    diagrams: briefDiagrams(v2),
    version: 2,
    versions,
    sessions,
    ...over,
  });

describe("BriefSummary", () => {
  test("5–8 theses and three thumbnails; a thumbnail opens its diagram, the button the whole brief", async () => {
    const onOpen = vi.fn();
    const r = await render(h(BriefSummary, { brief: v2, diagrams: briefDiagrams(v2), version: 2, onOpen }));
    const theses = r.$("p-brief-theses").querySelectorAll("li");
    expect(theses.length).toBeGreaterThanOrEqual(5);
    expect(theses.length).toBeLessThanOrEqual(8);
    expect(r.$("p-brief-summary-version").textContent).toBe("версия 2");
    for (const k of ["journey", "dataRoles", "integrations"])
      expect(r.$(`p-brief-thumb-${k}`).querySelector("svg")).not.toBeNull();
    await click(r.$("p-brief-thumb-dataRoles"));
    expect(onOpen).toHaveBeenLastCalledWith("dataRoles");
    await click(r.$("p-brief-open"));
    expect(onOpen).toHaveBeenLastCalledWith();
  });
});

describe("BriefPanel", () => {
  test("tabs follow the arrows, Home and End; the panel of the selected tab is shown", async () => {
    const r = await render(panel());
    const tab = (t: string) => r.$(`p-brief-tab-${t}`);
    expect(tab("brief").getAttribute("aria-selected")).toBe("true");
    expect(tab("brief").tabIndex).toBe(0);
    expect(tab("diagrams").tabIndex).toBe(-1);
    const key = async (k: string) => {
      const { act } = await import("react");
      await act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true }),
        );
      });
    };
    tab("brief").focus();
    await key("ArrowRight");
    expect(tab("diagrams").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("diagrams"));
    expect(r.$("p-brief-body-diagrams").querySelectorAll("figure")).toHaveLength(3);
    await key("End");
    expect(tab("sessions").getAttribute("aria-selected")).toBe("true");
    await key("ArrowRight");
    expect(tab("brief").getAttribute("aria-selected")).toBe("true");
    await key("ArrowLeft");
    expect(tab("sessions").getAttribute("aria-selected")).toBe("true");
  });

  test("what the latest version changed is marked by a word; «Показать разницу» opens it on «Версии»", async () => {
    const r = await render(panel());
    const marked = [...r.container.querySelectorAll<HTMLElement>("[data-changed]")];
    expect(marked.map((m) => m.getAttribute("data-testid"))).toEqual([
      "p-brief-section-audience",
      "p-brief-item",
    ]);
    const item = marked[1] as HTMLElement;
    expect(item.textContent).toContain("новое");
    expect(item.textContent).toContain("клиент оставляет отзыв");
    expect(r.$("p-brief-news").textContent).toContain("В версии 2 — 2 изменения");
    await click(r.$("p-brief-news-all"));
    expect(r.$("p-brief-tab-versions").getAttribute("aria-selected")).toBe("true");
    expect(r.$("p-brief-version-2").getAttribute("aria-current")).toBe("true");
    const changes = r.$$("p-brief-change");
    expect(changes.map((c) => c.getAttribute("data-op"))).toEqual(["changed", "added"]);
    expect(changes[0]?.querySelector("del")?.textContent).toContain("Жители района 25–55 лет");
    expect(changes[0]?.querySelector("ins")?.textContent).toContain("Жители района");
    await click(r.$("p-brief-version-1"));
    expect(r.$("p-brief-diff").textContent).toContain("Версия 1: первый бриф");
    expect(r.$$("p-brief-change").length).toBe(versions[1]?.diff.length);
  });

  test("a version of a session opens on «Версии»; no onSave — no «Изменить»", async () => {
    const r = await render(panel());
    expect(r.$$("p-brief-edit-goals")).toHaveLength(0);
    await click(r.$("p-brief-tab-sessions"));
    await click(r.$("p-session-version-1"));
    expect(r.$("p-brief-tab-versions").getAttribute("aria-selected")).toBe("true");
    expect(r.$("p-brief-version-1").getAttribute("aria-current")).toBe("true");
  });

  test("«Изменить» opens the editor of the section; a new version closes it", async () => {
    const onSave = vi.fn();
    const r = await render(panel({ onSave }));
    await click(r.$("p-brief-edit-roles"));
    expect(r.$("p-brief-edit-section-roles").getAttribute("aria-pressed")).toBe("true");
    await click(r.$("p-brief-save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[1]).toBe(2);
    const v3 = parse({ ...v2, audience: "Все" });
    await r.rerender(
      panel({
        onSave,
        brief: v3,
        version: 3,
        versions: [{ version: 3, diff: briefDiff(v2, v3), author: "owner", createdAt: "" }, ...versions],
      }),
    );
    expect(r.$$("p-brief-editor")).toHaveLength(0);
    expect(r.$("p-brief-panel-version").textContent).toContain("Версия 3");
  });
});

describe("BriefEditor", () => {
  test("an edited goal goes to onSave as a valid brief with the base version", async () => {
    const onSave = vi.fn();
    const r = await render(h(BriefEditor, { brief: v2, baseVersion: 7, onSave }));
    const inputs = r.$("p-brief-edit-goals").querySelectorAll("input");
    await type(inputs[1] as Element, "Не меньше 50 записей в месяц");
    await click(r.$("p-brief-save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved, base] = onSave.mock.calls[0] as [SystemBrief, number];
    expect(base).toBe(7);
    expect(saved.goals[0]?.success).toBe("Не меньше 50 записей в месяц");
    expect(briefDiff(v2, saved).map((c) => c.text_ru)).toEqual([
      "Цели, «Получать записи на приём с сайта»: изменено «Признак успеха»",
    ]);
  });

  test("a scenario without steps is explained in words and not saved", async () => {
    const onSave = vi.fn();
    const r = await render(h(BriefEditor, { brief: v2, baseVersion: 2, section: "scenarios", onSave }));
    await click(r.$("p-brief-add-scenarios"));
    const items = r.$("p-brief-edit-scenarios").querySelectorAll("li");
    const last = items[items.length - 1] as HTMLElement;
    await type(last.querySelector("input") as Element, "клиент отменяет запись");
    await click(r.$("p-brief-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(r.$("p-brief-editor-errors").getAttribute("role")).toBe("alert");
    expect(r.$("p-brief-editor-errors").textContent).toMatch(/Сценарии, № 6, «Что делает система»/);
    await type(last.querySelector("textarea") as Element, "освобождает время\nуведомляет врача");
    await click(r.$("p-brief-save"));
    const saved = onSave.mock.calls[0]?.[0] as SystemBrief;
    expect(saved.scenarios.at(-1)).toMatchObject({
      id: "s_6",
      actor: "visitor",
      when: "клиент отменяет запись",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["освобождает время", "уведомляет врача"],
      priority: "must",
    });
  });

  test("a removed goal drops the scenario links to it; empty new rows are ignored", async () => {
    const onSave = vi.fn();
    const r = await render(h(BriefEditor, { brief: v2, baseVersion: 2, onSave }));
    await click(r.container.querySelector('[aria-label="Убрать цель 1"]') as Element);
    await click(r.$("p-brief-add-goals"));
    await click(r.$("p-brief-save"));
    const saved = onSave.mock.calls[0]?.[0] as SystemBrief;
    expect(saved.goals.map((g) => g.id)).toEqual(["g_no_shows"]);
    expect(saved.scenarios.find((x) => x.id === "s_book")?.goalId).toBeUndefined();
    expect(saved.scenarios.find((x) => x.id === "s_remind")?.goalId).toBe("g_no_shows");
  });

  test("every field has a label", async () => {
    const r = await render(
      h(BriefEditor, { brief: v2, baseVersion: 2, section: "scenarios", onSave: () => {} }),
    );
    for (const el of r.container.querySelectorAll("input:not([type=checkbox]), textarea, select"))
      expect(r.container.querySelector(`label[for="${el.id}"]`), el.outerHTML).not.toBeNull();
  });
});

describe("SessionsFeed", () => {
  test("interviews, builds and edits in plain words with status, versions and changes", async () => {
    const r = await render(h(SessionsFeed, { sessions }));
    const items = r.$$("p-session");
    expect(items.map((i) => i.getAttribute("data-kind"))).toEqual(["edit", "build", "interview"]);
    expect(items[0]?.textContent).toContain("Правка в панели «Бриф»");
    expect(items[0]?.textContent).toContain("и ещё 1");
    expect(items[1]?.textContent).toContain("Пересборка");
    expect(items[1]?.textContent).toContain("не получилось");
    expect(items[1]?.textContent).toContain("Кончилось время");
    expect(items[1]?.textContent).toContain("12 мин");
    expect(items[2]?.textContent).toContain("Интервью");
    const empty = await render(h(SessionsFeed, { sessions: [] }));
    expect(empty.container.textContent).toContain("Сессий пока нет");
  });
});
