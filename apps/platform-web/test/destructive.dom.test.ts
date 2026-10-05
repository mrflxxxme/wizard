// @vitest-environment happy-dom
// M2-72 in the DOM with API doubles (platform-screens.yaml S7): a change that removes data shows its consequences in
// words; «Опубликовать» waits for the owner's confirmation of this list; a non-owner sees who can confirm; a stale
// confirmation asks again; «Отменить правку» starts the undo run.
import { act, type ComponentProps, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import type { DestructiveConsequences, DestructiveJournal, GateReport, Me } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { UndoPanel } from "../src/features/destructive/DestructivePanel.js";
import { destructiveRu } from "../src/i18n/ru/destructive.js";
import { DiffCard } from "../src/screens/workspace/DiffCard.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYSTEM = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";
const me: Me = {
  user: { id: "u1", email: "owner@example.test" },
  memberships: [{ orgId: ORG, orgName: "Заявки", role: "owner" }],
};
const LINE =
  "Удаление поля „Телефон“ в разделе „Заявки“ затронет 112 записей. Значения сохранятся в архиве, правку можно отменить.";
const HASH = "a".repeat(64);

function consequences(over: Partial<DestructiveConsequences> = {}): DestructiveConsequences {
  return {
    revision: 7,
    baseRevision: 6,
    required: true,
    blocking: false,
    hash: HASH,
    changes: [
      {
        kind: "drop_column",
        entity: "lead",
        entityLabel: "Заявки",
        field: "phone",
        fieldLabel: "Телефон",
        affected: 112,
        unconvertible: 0,
        archived: true,
        blocking: false,
        text_ru: LINE,
      },
    ],
    confirmation: null,
    canConfirm: true,
    ...over,
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function waitFor(cond: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

function mount(api: Partial<ApiClient>, node: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const full = { getMe: async () => me, getOrgSettings: async () => ({}), ...api } as ApiClient;
  act(() =>
    root?.render(h(PlatformProvider, { api: full } as ComponentProps<typeof PlatformProvider>, node)),
  );
  return container;
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const reports: GateReport[] = [];
const card = () =>
  h(DiffCard, {
    systemId: SYSTEM,
    revision: 7,
    changes: [
      {
        kind: "field",
        text_ru: "Из «Заявки» удалено поле «Телефон» вместе со значениями",
        destructive: true,
      },
    ],
    reports,
    blockers: [],
    canCancel: true,
    busy: null,
    onCancel: () => {},
    onPublish: () => {},
  });

describe("S7: confirmation of a change that removes data", () => {
  test("the owner reads the consequences, confirms them, then «Опубликовать» is enabled", async () => {
    let state = consequences();
    const confirmDestructive = vi.fn(async (_id: string, body: { revision: number; hash: string }) => {
      state = consequences({ confirmation: { status: "confirmed", confirmedAt: "2026-10-05T10:00:00Z" } });
      return { change: {} as never, consequences: state, body };
    });
    const el = mount({ getDestructive: async () => state, confirmDestructive }, card());
    await waitFor(() => q(el, "destructive-line") !== null);
    expect(q(el, "destructive-line")?.textContent).toBe(LINE);
    expect((q(el, "diff-publish") as HTMLButtonElement).disabled).toBe(true);
    act(() => q(el, "destructive-confirm")?.click());
    await waitFor(() => q(el, "destructive-confirmed") !== null);
    expect(confirmDestructive).toHaveBeenCalledWith(SYSTEM, { revision: 7, hash: HASH });
    await waitFor(() => !(q(el, "diff-publish") as HTMLButtonElement).disabled);
  });

  test("a non-owner sees who confirms; publishing stays disabled", async () => {
    const el = mount({ getDestructive: async () => consequences({ canConfirm: false }) }, card());
    await waitFor(() => q(el, "destructive-owner-only") !== null);
    expect(q(el, "destructive-owner-only")?.textContent).toBe(destructiveRu.ownerOnly);
    expect(q(el, "destructive-confirm")).toBeNull();
    expect((q(el, "diff-publish") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a stale confirmation asks to confirm again", async () => {
    const el = mount(
      {
        getDestructive: async () =>
          consequences({ confirmation: { status: "stale", confirmedAt: "2026-10-05T10:00:00Z" } }),
      },
      card(),
    );
    await waitFor(() => q(el, "destructive-stale") !== null);
    expect(q(el, "destructive-confirm")).not.toBeNull();
    expect((q(el, "diff-publish") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a blocking line (a new rule existing records break) cannot be confirmed", async () => {
    const blocking = consequences({ blocking: true });
    const first = blocking.changes[0] as DestructiveConsequences["changes"][number];
    blocking.changes = [{ ...first, kind: "alter_check", blocking: true }];
    const el = mount({ getDestructive: async () => blocking }, card());
    await waitFor(() => q(el, "destructive-blocking") !== null);
    expect(q(el, "destructive-confirm")).toBeNull();
  });
});

describe("«Отменить правку»", () => {
  const journal: DestructiveJournal = {
    items: [
      {
        id: "c1",
        revision: 7,
        baseRevision: 6,
        status: "applied",
        consequences: consequences().changes,
        confirmedBy: "u1",
        confirmedAt: "2026-10-05T10:00:00Z",
        appliedAt: "2026-10-05T10:01:00Z",
        undoneBy: null,
        undoneAt: null,
        undoRunId: null,
        undoable: true,
      },
    ],
    undo: { changeId: "c1", toRevision: 6 },
    canUndo: true,
  };

  test("the owner starts the undo run", async () => {
    const onRun = vi.fn();
    const undoDestructiveChange = vi.fn(async () => ({ run: { id: "run-1" } as never }));
    const el = mount(
      { listDestructiveChanges: async () => journal, undoDestructiveChange },
      h(UndoPanel, { systemId: SYSTEM, prodRevision: 7, onRun }),
    );
    await waitFor(() => q(el, "destructive-undo-submit") !== null);
    expect(q(el, "destructive-undo")?.textContent).toContain(LINE);
    act(() => q(el, "destructive-undo-submit")?.click());
    await waitFor(() => onRun.mock.calls.length > 0);
    expect(undoDestructiveChange).toHaveBeenCalledWith(SYSTEM, "c1");
    expect(onRun).toHaveBeenCalledWith("run-1");
  });

  test("nothing to undo → no panel; a non-owner sees who can undo", async () => {
    const empty = mount(
      { listDestructiveChanges: async () => ({ items: [], undo: null, canUndo: true }) },
      h(UndoPanel, { systemId: SYSTEM, prodRevision: 7, onRun: () => {} }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(q(empty, "destructive-undo")).toBeNull();
    act(() => root?.unmount());
    const el = mount(
      { listDestructiveChanges: async () => ({ ...journal, canUndo: false }) },
      h(UndoPanel, { systemId: SYSTEM, prodRevision: 7, onRun: () => {} }),
    );
    await waitFor(() => q(el, "destructive-undo-owner-only") !== null);
    expect(q(el, "destructive-undo-submit")).toBeNull();
  });
});
