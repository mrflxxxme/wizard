// @vitest-environment happy-dom
// B2-32 acceptance (DOM): behaviour of the v2 components — question card, input row, canvas block, chat sheet, theme root.
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyPlatformTheme,
  CanvasBlock,
  ChatSheet,
  Composer,
  QuestionCard,
  ThemeRoot,
  XrayLines,
} from "../src/v2/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(el: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(el));
  const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  return { container, $, rerender: (n: ReactNode) => act(async () => root.render(n)) };
}

const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const reducedMotion = (on: boolean) =>
  vi
    .spyOn(window, "matchMedia")
    .mockImplementation((q: string) => ({ matches: on && q.includes("reduce"), media: q }) as MediaQueryList);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("QuestionCard", () => {
  test("options are pressable chips; the recommended one says «советуем»; «Дальше» needs a choice", async () => {
    const onToggle = vi.fn();
    const onSubmit = vi.fn();
    const props = {
      step: "Вопрос 2 из 5",
      question: "Как пациенты будут записываться?",
      options: [
        { id: "a", label: "Онлайн-запись", recommended: true },
        { id: "b", label: "По телефону" },
      ],
      onToggle,
      onSubmit,
    };
    const r = await render(h(QuestionCard, { ...props, selected: [] }));
    const a = r.$("p-question-option-a");
    expect(a.getAttribute("aria-pressed")).toBe("false");
    expect(a.textContent).toBe("Онлайн-записьсоветуем");
    expect(r.$("p-question-option-b").textContent).not.toContain("советуем");
    expect((r.$("p-question-submit") as HTMLButtonElement).disabled).toBe(true);
    await click(r.$("p-question-option-b"));
    expect(onToggle).toHaveBeenCalledWith("b");
    await r.rerender(h(QuestionCard, { ...props, selected: ["b"] }));
    expect(r.$("p-question-option-b").getAttribute("aria-pressed")).toBe("true");
    await click(r.$("p-question-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(r.container.querySelector("h2")?.textContent).toBe(props.question);
  });
});

describe("Composer", () => {
  test("submits trimmed text, not empty; shows the selected block and suggestions; states", async () => {
    const onSubmit = vi.fn();
    const onClear = vi.fn();
    const onSuggestion = vi.fn();
    const base = { onChange: () => {}, onSubmit, onSuggestion };
    const r = await render(h(Composer, { ...base, value: "   " }));
    expect((r.$("p-composer-send") as HTMLButtonElement).disabled).toBe(true);
    const input = r.$("p-composer-input") as HTMLInputElement;
    expect(r.container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Сообщение");
    await r.rerender(
      h(Composer, {
        ...base,
        value: "  Другой цвет  ",
        state: "thinking",
        target: { label: "Услуги и цены", onClear },
        suggestions: [{ id: "view", label: "Другой вид" }],
      }),
    );
    expect(r.$("p-composer").getAttribute("data-state")).toBe("thinking");
    expect(r.$("p-composer").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      r.$("p-composer-row").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith("Другой цвет");
    expect(r.$("p-composer-target").getAttribute("aria-label")).toBe("Снять выбор: Услуги и цены");
    await click(r.$("p-composer-target"));
    expect(onClear).toHaveBeenCalled();
    await click(r.$("p-composer-suggestion-view"));
    expect(onSuggestion).toHaveBeenCalledWith("view");
  });
});

describe("CanvasBlock", () => {
  test("materializing → onMaterialized after the animation; immediately with reduced motion", async () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const done = vi.fn();
    const r = await render(h(CanvasBlock, { state: "materializing", onMaterialized: done }, "Запись"));
    expect(r.$("p-block").getAttribute("data-state")).toBe("materializing");
    expect(r.$("p-block").getAttribute("aria-busy")).toBe("true");
    expect(done).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1600));
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    vi.restoreAllMocks();
    reducedMotion(true);
    const done2 = vi.fn();
    await render(h(CanvasBlock, { state: "materializing", onMaterialized: done2 }, "Врачи"));
    expect(done2).toHaveBeenCalledTimes(1);
  });

  test("motion off on the root (data-p-motion=off) also skips the wait", async () => {
    reducedMotion(false);
    const done = vi.fn();
    await render(
      h(
        ThemeRoot,
        { motion: false },
        h(CanvasBlock, { state: "materializing", onMaterialized: done }, "Запись"),
      ),
    );
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("ready + onSelect: a button with the block name; Enter selects; sketch is not pickable", async () => {
    const onSelect = vi.fn();
    const r = await render(h(CanvasBlock, { state: "ready", label: "Врачи", onSelect, selected: true }, "x"));
    const b = r.$("p-block");
    expect(b.getAttribute("role")).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("Врачи");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.hasAttribute("data-selected")).toBe(true);
    await act(
      async () => void b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    await r.rerender(h(CanvasBlock, { state: "sketch", label: "Врачи", onSelect }, "x"));
    expect(r.$("p-block").getAttribute("role")).toBeNull();
  });

  test("pickSketch (B2-29): a sketch block of a plan is pickable, a materializing one is not", async () => {
    const onSelect = vi.fn();
    const r = await render(
      h(CanvasBlock, { state: "sketch", label: "Услуги", onSelect, pickSketch: true }, "x"),
    );
    expect(r.$("p-block").getAttribute("role")).toBe("button");
    await r.rerender(
      h(CanvasBlock, { state: "materializing", label: "Услуги", onSelect, pickSketch: true }, "x"),
    );
    expect(r.$("p-block").getAttribute("role")).toBeNull();
  });
});

describe("ChatSheet", () => {
  test("handle toggles the history (aria-expanded), Esc closes; no handle without history", async () => {
    const onOpenChange = vi.fn();
    const r = await render(
      h(ChatSheet, { open: false, onOpenChange, history: h("p", null, "Привет") }, "dock"),
    );
    const grab = r.$("p-sheet-grab");
    expect(grab.getAttribute("aria-expanded")).toBe("false");
    expect(grab.getAttribute("aria-controls")).toBe(r.$("p-sheet-history").id);
    expect(r.$("p-sheet-history").getAttribute("role")).toBe("log");
    await click(grab);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await r.rerender(h(ChatSheet, { open: true, onOpenChange, history: h("p", null, "Привет") }, "dock"));
    expect(r.$("p-sheet-grab").getAttribute("aria-label")).toBe("Скрыть переписку");
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await r.rerender(h(ChatSheet, { open: false, onOpenChange }, "dock"));
    expect(r.$("p-sheet-grab")).toBeNull();
  });
});

describe("theme root and x-ray", () => {
  test("applyPlatformTheme: theme, glass, grain, business colour as CSS variables for both schemes (no <style>, CSP); null removes it", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const styles = document.head.querySelectorAll("style").length;
    applyPlatformTheme(el, { theme: "dark", business: "#0f766e", glass: false });
    expect(el.hasAttribute("data-p-root")).toBe(true);
    expect(el.getAttribute("data-p-theme")).toBe("dark");
    expect(el.getAttribute("data-p-glass")).toBe("off");
    expect(el.hasAttribute("data-p-grain")).toBe(true);
    expect(el.getAttribute("data-p-biz")).toBe("#0F766E");
    expect(el.style.getPropertyValue("--p-biz-light")).toBe("#0F766E");
    expect(el.style.getPropertyValue("--p-biz-text-dark")).toBeTruthy();
    expect(el.style.getPropertyValue("--p-biz-wash-dark")).toBeTruthy();
    expect(document.head.querySelectorAll("style").length).toBe(styles);
    applyPlatformTheme(el, { business: null });
    expect(el.hasAttribute("data-p-biz")).toBe(false);
    expect(el.hasAttribute("data-p-theme")).toBe(false);
    expect(el.style.getPropertyValue("--p-biz-light")).toBe("");
  });

  test("XrayLines: numbered steps in order, a path per known edge, hidden from assistive tech when off", async () => {
    const nodes = [
      { id: "a", x: 0, y: 0, label: "Клиент записался" },
      { id: "b", x: 100, y: 100, label: "Напоминание" },
    ];
    const r = await render(
      h(XrayLines, {
        width: 100,
        height: 100,
        nodes,
        edges: [
          ["a", "b"],
          ["a", "zzz"],
        ],
        visible: false,
      }),
    );
    expect(r.$("p-xray").getAttribute("aria-hidden")).toBe("true");
    expect(r.container.querySelectorAll("path")).toHaveLength(2);
    expect(r.$("p-xray-node-b").textContent).toBe("2Напоминание");
  });
});
