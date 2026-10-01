// @vitest-environment happy-dom
// M1-12 S-import in the DOM with API doubles: the proposed mapping, PII by piiKindGuess (basic), editing a column,
// PUT mapping + needs_input confirm, 422 problems at the row, cancel, result; only the column schema is rendered
// (no cell values even if a response carried them); the «Загрузить таблицу» button of the workspace (roles, 413).
import { act, type ComponentProps, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { ImportColumnMapping, ImportView, Me, OrgRole } from "../src/api/types.js";
import { App } from "../src/app/App.js";
import { PlatformProvider } from "../src/app/context.js";
import { matchRoute } from "../src/app/router.js";
import { applyTarget, fullMapping, targetValue } from "../src/screens/import/ImportScreen.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "22222222-2222-4222-8222-222222222222";
const SYS = "33333333-3333-4333-8333-333333333333";
const IMP = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const CANARY = "Кривошеин Всеволод";

const me = (role: OrgRole): Me => ({
  user: { id: "u1", email: "anna@example.test" },
  memberships: [{ orgId: ORG, orgName: "Северный ритейл", role }],
});

const SPEC = {
  entities: [
    {
      name: "stream",
      label: "Поток",
      fields: [
        { name: "name", label: "Название", type: "string" },
        { name: "capacity", label: "Вместимость", type: "int" },
        { name: "description", label: "Описание", type: "text" },
      ],
    },
    {
      name: "ticket",
      label: "Билет",
      fields: [
        { name: "holder_user", label: "Владелец", type: "ref" },
        { name: "holder_phone", label: "Телефон", type: "phone" },
      ],
    },
  ],
};

function importView(over: Partial<ImportView> = {}): ImportView {
  return {
    id: IMP,
    status: "awaiting_confirm",
    runId: RUN,
    inputId: "in-1",
    profile: [
      { column: "Название потока", typeGuess: "string", piiKindGuess: null, nullShare: 0, distinct: 12 },
      { column: "Вместимость", typeGuess: "integer", piiKindGuess: null, nullShare: 0, distinct: 7 },
      { column: "Описание", typeGuess: "free_text", piiKindGuess: null, nullShare: 0.25, distinct: 9 },
      { column: "Телефон", typeGuess: "phone", piiKindGuess: "phone", nullShare: 0, distinct: 12 },
    ],
    mapping: [
      { column: "Название потока", action: "map", entity: "stream", field: "name", pii: "none" },
      { column: "Вместимость", action: "map", entity: "stream", field: "capacity", pii: "none" },
      { column: "Описание", action: "skip", pii: "none" },
      { column: "Телефон", action: "skip", pii: "basic" },
    ],
    rowsImported: null,
    ...over,
  };
}

const systemView = (previewRevision: number | null) =>
  ({
    system: {
      id: SYS,
      orgId: ORG,
      name: "Форум",
      slug: "forum",
      stage: "ready",
      draftRevision: 3,
      previewRevision,
      prodRevision: null,
      createdAt: "",
    },
    messages: [],
  }) as never;

/** API double: listed methods; anything else the screens call rejects (no network in DOM tests). */
function doubles(api: Partial<ApiClient>): ApiClient {
  return new Proxy(api, {
    get: (t, k) =>
      (t as Record<string | symbol, unknown>)[k] ??
      (() => Promise.reject(new Error(`no double: ${String(k)}`))),
  }) as ApiClient;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  window.localStorage.clear();
});

function mountApp(api: Partial<ApiClient>, url: string): HTMLDivElement {
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const app: ReactElement = h(App);
  act(() =>
    root?.render(h(PlatformProvider, { api: doubles(api) } as ComponentProps<typeof PlatformProvider>, app)),
  );
  return container;
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

const q = <T extends HTMLElement = HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => act(() => el?.click());
function choose(el: HTMLSelectElement | null, value: string) {
  if (!el) throw new Error("no select");
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function importApi(role: OrgRole, views: ImportView[], over: Partial<ApiClient> = {}) {
  let i = 0;
  const getImport = vi.fn(async () => views[Math.min(i++, views.length - 1)] as ImportView);
  const updateImportMapping = vi.fn(async (_s: string, _i: string, mapping: ImportColumnMapping[]) => ({
    mapping,
  }));
  const provideInput = vi.fn(async () => ({}) as never);
  const api: Partial<ApiClient> = {
    getMe: async () => me(role),
    getOrgSettings: async () => ({ ruOnly: false }),
    getSystem: async () => systemView(3),
    getRevision: async () => ({ version: 3, spec: SPEC, files: [], ops: [] }) as never,
    getImport: getImport as unknown as ApiClient["getImport"],
    updateImportMapping: updateImportMapping as unknown as ApiClient["updateImportMapping"],
    provideInput: provideInput as unknown as ApiClient["provideInput"],
    ...over,
  };
  return { api, getImport, updateImportMapping, provideInput, skip: (n: number) => (i += n) };
}

describe("mapping helpers", () => {
  test("select values round-trip map / new field / skip and keep pii", () => {
    const m: ImportColumnMapping = { column: "Телефон", action: "skip", pii: "basic" };
    expect(targetValue(m)).toBe("skip");
    const mapped = applyTarget(m, "map:ticket.holder_phone");
    expect(mapped).toEqual({
      column: "Телефон",
      action: "map",
      entity: "ticket",
      field: "holder_phone",
      pii: "basic",
    });
    expect(targetValue(mapped)).toBe("map:ticket.holder_phone");
    const nf = applyTarget(mapped, "new:stream");
    expect(nf).toEqual({ column: "Телефон", action: "new_field", entity: "stream", pii: "basic" });
    expect(targetValue(applyTarget({ ...nf, field: "curator_phone" }, "new:stream"))).toBe("new:stream");
    expect(applyTarget({ ...nf, field: "curator_phone" }, "new:stream").field).toBe("curator_phone");
    expect(applyTarget(nf, "skip")).toEqual({ column: "Телефон", action: "skip", pii: "basic" });
  });

  test("full mapping: columns without an item are skipped, PII by piiKindGuess", () => {
    const profile = importView().profile;
    const out = fullMapping(profile, new Map());
    expect(out.map((m) => [m.column, m.action, m.pii])).toEqual([
      ["Название потока", "skip", "none"],
      ["Вместимость", "skip", "none"],
      ["Описание", "skip", "none"],
      ["Телефон", "skip", "basic"],
    ]);
  });

  test("route /s/:id/import/:importId", () => {
    expect(matchRoute(`/s/${SYS}/import/${IMP}`)).toEqual({ name: "import", systemId: SYS, importId: IMP });
  });
});

describe("S-import", () => {
  test("proposed mapping: notice, a row per column, «Телефон» marked basic, fields of the preview spec", async () => {
    const { api } = importApi("editor", [importView()]);
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-row-Телефон") !== null);
    expect(q(el, "import-notice")?.textContent).toContain(
      "Моделям за рубежом передаются только названия колонок и синтетические строки",
    );
    for (const c of ["Название потока", "Вместимость", "Описание", "Телефон"])
      expect(q(el, `import-row-${c}`)).not.toBeNull();
    expect(q<HTMLSelectElement>(el, "import-pii-Телефон")?.value).toBe("basic");
    expect(q<HTMLSelectElement>(el, "import-pii-Описание")?.value).toBe("none");
    expect(q(el, "import-row-Телефон")?.textContent).toContain("похоже на: телефон");
    const target = q<HTMLSelectElement>(el, "import-target-Название потока");
    expect(target?.value).toBe("map:stream.name");
    const options = [...(target?.options ?? [])].map((o) => o.value);
    // Only importable field types are offered (ref is not), plus a new field per entity and «Пропустить».
    expect(options).toContain("map:ticket.holder_phone");
    expect(options).not.toContain("map:ticket.holder_user");
    expect(options).toContain("new:stream");
    expect(options[0]).toBe("skip");
    expect(target?.getAttribute("aria-label")).toBe("Куда загрузить колонку «Название потока»");
    expect(q(el, "import-confirm")?.textContent).toContain("Загрузить 2 колонки");
  });

  test("no cell values on screen even if a response carried them: only the column schema is rendered", async () => {
    const leaky = importView();
    (leaky.profile[0] as unknown as Record<string, unknown>).sample = [CANARY];
    (leaky.profile[3] as unknown as Record<string, unknown>).examples = ["+7 916 510-00-10"];
    (leaky as unknown as Record<string, unknown>).syntheticRows = [{ col_1: CANARY }];
    const { api } = importApi("editor", [leaky]);
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-row-Телефон") !== null);
    expect(el.textContent).not.toContain(CANARY);
    expect(el.textContent).not.toContain("+7 916");
    expect(el.innerHTML).not.toContain(CANARY);
  });

  test("edit a column → PUT mapping (full, with the edit) → needs_input confirm → result", async () => {
    const done = importView({ status: "done", inputId: null, rowsImported: 12 });
    const importing = importView({ status: "importing", inputId: null });
    const { api, updateImportMapping, provideInput, getImport } = importApi("editor", [
      importView(),
      importing,
      done,
    ]);
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-target-Описание") !== null);
    choose(q(el, "import-target-Описание"), "map:stream.description");
    expect(q(el, "import-confirm")?.textContent).toContain("Загрузить 3 колонки");
    click(q(el, "import-confirm"));
    await waitFor(() => provideInput.mock.calls.length === 1);
    expect(updateImportMapping).toHaveBeenCalledWith(SYS, IMP, [
      { column: "Название потока", action: "map", entity: "stream", field: "name", pii: "none" },
      { column: "Вместимость", action: "map", entity: "stream", field: "capacity", pii: "none" },
      { column: "Описание", action: "map", entity: "stream", field: "description", pii: "none" },
      { column: "Телефон", action: "skip", pii: "basic" },
    ]);
    expect(provideInput).toHaveBeenCalledWith(RUN, { inputId: "in-1", choice: "confirm" });
    await waitFor(() => q(el, "import-result") !== null);
    expect(q(el, "import-result")?.textContent).toContain("Импортировано строк: 12");
    expect(getImport.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(q(el, "import-confirm")).toBeNull();
    click(q(el, "import-open-system"));
    expect(window.location.pathname).toBe(`/s/${SYS}`);
  });

  test("new field: entity choice + optional latin name; PII unmarked only explicitly", async () => {
    const { api, updateImportMapping } = importApi("editor", [importView()]);
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-target-Телефон") !== null);
    choose(q(el, "import-target-Телефон"), "new:stream");
    type(q(el, "import-new-field-Телефон"), "curator_phone");
    choose(q(el, "import-pii-Описание"), "basic");
    click(q(el, "import-confirm"));
    await waitFor(() => updateImportMapping.mock.calls.length === 1);
    const sent = updateImportMapping.mock.calls[0]?.[2] ?? [];
    expect(sent.find((m) => m.column === "Телефон")).toEqual({
      column: "Телефон",
      action: "new_field",
      entity: "stream",
      field: "curator_phone",
      pii: "basic",
    });
    expect(sent.find((m) => m.column === "Описание")?.pii).toBe("basic");
  });

  test("422 OPS_INVALID: problems at the rows, no confirmation sent", async () => {
    const { api, provideInput } = importApi("editor", [importView()], {
      updateImportMapping: async () => {
        throw new ApiError(422, {
          code: "OPS_INVALID",
          message_ru: "Сопоставление не сохранено: исправьте колонки",
          details: {
            problems: [{ column: "Вместимость", message_ru: "В это поле уже загружается другая колонка" }],
          },
        });
      },
    });
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-confirm") !== null);
    click(q(el, "import-confirm"));
    await waitFor(() => q(el, "import-action-error") !== null);
    expect(q(el, "import-row-Вместимость")?.textContent).toContain(
      "В это поле уже загружается другая колонка",
    );
    expect(q(el, "import-target-Вместимость")?.getAttribute("aria-invalid")).toBe("true");
    expect(provideInput).not.toHaveBeenCalled();
  });

  test("cancel → needs_input choice cancel → back to the system", async () => {
    const { api, provideInput } = importApi("editor", [importView()]);
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-cancel") !== null);
    click(q(el, "import-cancel"));
    await waitFor(() => window.location.pathname === `/s/${SYS}`);
    expect(provideInput).toHaveBeenCalledWith(RUN, { inputId: "in-1", choice: "cancel" });
  });

  test("progress while profiling; failed run shows its message", async () => {
    const { api } = importApi(
      "editor",
      [
        importView({ status: "profiling", inputId: null, profile: [], mapping: [] }),
        importView({ status: "failed", inputId: null }),
      ],
      {
        getRun: async () =>
          ({
            id: RUN,
            kind: "import_table",
            status: "failed",
            failure: { code: "X", message_ru: "Сбой" },
          }) as never,
      },
    );
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-progress") !== null);
    expect(q(el, "import-progress")?.textContent).toContain("Читаю таблицу");
    await waitFor(() => q(el, "import-failed")?.textContent?.includes("Сбой") === true);
  });

  test("viewer: the screen says import is for editors and does not read the import", async () => {
    const { api, getImport } = importApi("viewer", [importView()]);
    const el = mountApp(api, `/s/${SYS}/import/${IMP}`);
    await waitFor(() => q(el, "import-error") !== null);
    expect(q(el, "import-error")?.textContent).toBe("Импорт таблиц доступен редактору и владельцу");
    expect(getImport).not.toHaveBeenCalled();
  });
});

describe("workspace «Загрузить таблицу»", () => {
  function pick(el: HTMLElement, file: File) {
    const input = q<HTMLInputElement>(el, "chat-upload-file");
    if (!input) throw new Error("no file input");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  test("editor: upload → POST imports with only the extension as the name → S-import", async () => {
    const createImport = vi.fn(async () => ({ importId: IMP, run: { id: RUN } as never }));
    const { api } = importApi("editor", [importView()], {
      createImport: createImport as unknown as ApiClient["createImport"],
    });
    const el = mountApp(api, `/s/${SYS}`);
    await waitFor(() => q<HTMLButtonElement>(el, "chat-upload")?.disabled === false);
    pick(el, new File([new Uint8Array([80, 75, 3, 4])], "Клиенты Иванова.xlsx"));
    await waitFor(() => window.location.pathname === `/s/${SYS}/import/${IMP}`);
    expect(createImport).toHaveBeenCalledWith(SYS, expect.any(File), "table.xlsx");
    await waitFor(() => q(el, "import-row-Телефон") !== null);
  });

  test("413 → «Файл слишком большой»; .xls is refused before upload", async () => {
    const createImport = vi.fn(async () => {
      throw new ApiError(413, { code: "PAYLOAD_TOO_LARGE", message_ru: "limit" });
    });
    const { api } = importApi("editor", [importView()], {
      createImport: createImport as unknown as ApiClient["createImport"],
    });
    const el = mountApp(api, `/s/${SYS}`);
    await waitFor(() => q<HTMLButtonElement>(el, "chat-upload")?.disabled === false);
    pick(el, new File(["a,b\n1,2\n"], "t.csv"));
    await waitFor(() => el.textContent?.includes("Файл слишком большой") === true);
    pick(el, new File(["x"], "old.xls"));
    await waitFor(() => el.textContent?.includes("Поддерживаются только файлы .xlsx и .csv") === true);
    expect(createImport).toHaveBeenCalledTimes(1);
  });

  test("viewer: disabled with a hint; not built yet: disabled until the first build", async () => {
    const viewer = mountApp(importApi("viewer", [importView()]).api, `/s/${SYS}`);
    await waitFor(() => q(viewer, "chat-upload") !== null && q(viewer, "chat-input") !== null);
    await waitFor(() => viewer.textContent?.includes("Загружает таблицы редактор или владелец") === true);
    expect(q<HTMLButtonElement>(viewer, "chat-upload")?.disabled).toBe(true);
    act(() => root?.unmount());
    container?.remove();

    const draft = mountApp(
      importApi("editor", [importView()], { getSystem: async () => systemView(null) }).api,
      `/s/${SYS}`,
    );
    await waitFor(() => draft.textContent?.includes("Таблицу можно загрузить после первой сборки") === true);
    expect(q<HTMLButtonElement>(draft, "chat-upload")?.disabled).toBe(true);
  });
});
