// @vitest-environment happy-dom
// M1-08: the revision diff is a list of human changes (+ новое / ~ изменено / − удалено), grouped by kind for the
// «Изменения» segment, with the migration verdict; signs are checked on real @wizard/appspec diffSpecs wording.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSpec, diffSpecs } from "@wizard/appspec";
import { act, type ComponentProps, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import type { DiffChange, GateReport } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { diffSign, groupChanges, migrationVerdict } from "../src/diff/human.js";
import { ChangesPanel, DiffCard } from "../src/screens/workspace/DiffCard.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const forum = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../specs/appspec/examples/forum.json"), "utf8"),
) as AppSpec;
const clone = (): AppSpec => structuredClone(forum);

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
const fakeApi = { getOrgSettings: async () => ({}) } as unknown as ApiClient;
/** ui-kit Button needs WzProvider: the platform provider brings it. */
const platform = (child: ReactElement) =>
  h(PlatformProvider, { api: fakeApi } as ComponentProps<typeof PlatformProvider>, child);

function mount(node: ReturnType<typeof h>): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

describe("diffSign on @wizard/appspec wording", () => {
  test("added field, entity, role, page → «+»; removed → «−»; renamed/changed → «~»", () => {
    const next = clone();
    const app = next.entities.find((e) => e.name === "speaker_application");
    app?.fields.push({ name: "track_theme", label: "Тема трека", type: "string" } as never);
    next.entities.push({
      name: "hall",
      label: "Зал",
      fields: [{ name: "title", label: "Название", type: "string" }],
    } as never);
    next.roles.push({ name: "guest", label: "Гость", access: "public" } as never);
    const stream = next.entities.find((e) => e.name === "stream");
    if (stream) stream.fields = stream.fields.filter((f) => f.name !== "description");
    next.pages = (next.pages ?? []).slice(1);
    const tt = next.entities.find((e) => e.name === "ticket_type");
    if (tt) tt.label = "Вид билета";
    const changes = diffSpecs(forum, next) as DiffChange[];
    const signOf = (re: RegExp) => changes.filter((c) => re.test(c.text_ru)).map(diffSign);
    expect(signOf(/Тема трека/)).toEqual(["add"]);
    expect(signOf(/Добавлены данные «Зал»/)).toEqual(["add"]);
    expect(signOf(/Добавлена роль «Гость»/)).toEqual(["add"]);
    expect(signOf(/удалено поле «Описание»/)).toEqual(["remove"]);
    expect(signOf(/Удалён экран/)).toEqual(["remove"]);
    expect(signOf(/переименованы в «Вид билета»/)).toEqual(["change"]);
    expect(changes.find((c) => /удалено поле/.test(c.text_ru))?.destructive).toBe(true);
  });

  test("file lines of platform-api", () => {
    expect(diffSign({ text_ru: "Добавлен файл ui/pages/landing.tsx" })).toBe("add");
    expect(diffSign({ text_ru: "Изменён файл ui/pages/landing.tsx" })).toBe("change");
    expect(diffSign({ text_ru: "Удалён файл functions/x.ts" })).toBe("remove");
    expect(diffSign({ text_ru: "Подключено: Telegram" })).toBe("add");
    expect(diffSign({ text_ru: "Отключено: Telegram" })).toBe("remove");
    expect(diffSign({ text_ru: "«Участник» больше не имеет доступа к «Билет»" })).toBe("remove");
    expect(diffSign({ text_ru: "«Участник» теперь может: смотреть — «Билет»" })).toBe("add");
  });
});

describe("grouping and migration", () => {
  const changes: DiffChange[] = [
    { kind: "file", text_ru: "Изменён файл ui/pages/landing.tsx" },
    { kind: "page", text_ru: "Новый экран «Залы»" },
    { kind: "field", text_ru: "В «Заявка спикера» добавлено поле «Тема трека» (строка)" },
    { kind: "permission", text_ru: "«Участник» теперь может: смотреть — «Залы»" },
  ];

  test("groups follow data → rights → screens → files", () => {
    expect(groupChanges(changes).map((g) => g.kind)).toEqual(["field", "permission", "page", "file"]);
  });

  test("verdict: additive for schema additions, destructive for any destructive line, none without schema", () => {
    expect(migrationVerdict(changes)).toBe("additive");
    expect(migrationVerdict([{ kind: "theme", text_ru: "Изменён стиль" }])).toBe("none");
    expect(
      migrationVerdict([
        ...changes,
        { kind: "field", text_ru: "Из «Поток» удалено поле «Описание»", destructive: true },
      ]),
    ).toBe("destructive");
  });
});

describe("DiffCard (S7)", () => {
  const reports: GateReport[] = [
    {
      level: "G0",
      passed: true,
      checks: [{ id: "a", status: "pass", severity: "blocker", message_ru: "ок" }],
    },
    {
      level: "G1",
      passed: true,
      checks: [{ id: "b", status: "pass", severity: "blocker", message_ru: "ок" }],
    },
  ];
  const noop = () => {};
  const card = (changes: DiffChange[] | null, blockers: string[] = []) =>
    mount(
      platform(
        h(DiffCard, {
          revision: 7,
          changes,
          reports,
          credits: 2.35,
          blockers,
          canCancel: true,
          busy: null,
          onCancel: noop,
          onPublish: noop,
        }),
      ),
    );
  const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

  test("lines with signs, additive migration, gates, price and «Опубликовать ревизию N+1»", () => {
    const el = card([{ kind: "field", text_ru: "В «Заявка спикера» добавлено поле «Тема трека» (строка)" }]);
    const line = q(el, "diff-line");
    expect(line?.textContent).toMatch(/^\+.*тема трека/i);
    expect(q(el, "diff-migration")?.textContent).toContain("аддитивная");
    expect(q(el, "diff-gates")?.textContent).toContain("G0 · G1");
    expect(q(el, "diff-price")?.textContent).toContain("2,4");
    const publish = q(el, "diff-publish") as HTMLButtonElement;
    expect(publish.textContent).toContain("Опубликовать ревизию 7");
    expect(publish.disabled).toBe(false);
  });

  test("a destructive change blocks publishing with the DESTRUCTIVE_IN_PROD text", () => {
    const el = card([
      {
        kind: "field",
        text_ru: "Из «Поток» удалено поле «Описание» вместе со значениями",
        destructive: true,
      },
    ]);
    expect(q(el, "diff-line")?.textContent?.startsWith("−")).toBe(true);
    expect(q(el, "diff-migration")?.textContent).toContain("удаляет данные");
    expect((q(el, "diff-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(q(el, "diff-destructive")?.textContent).toContain("В prod разрешены только добавления");
  });

  test("publish blockers disable publishing", () => {
    const el = card([{ kind: "page", text_ru: "Новый экран «Залы»" }], ["Публикует владелец"]);
    expect((q(el, "diff-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(q(el, "publish-blocker")?.textContent).toBe("Публикует владелец");
  });

  test("«Изменения» segment groups by kind with Russian headings", () => {
    const el = mount(
      h(ChangesPanel, {
        changes: [
          { kind: "file", text_ru: "Изменён файл ui/pages/landing.tsx" },
          { kind: "field", text_ru: "В «Заявка спикера» добавлено поле «Тема трека» (строка)" },
        ],
      }),
    );
    expect([...el.querySelectorAll("h3")].map((x) => x.textContent)).toEqual(["Поля данных", "Файлы кода"]);
  });
});
