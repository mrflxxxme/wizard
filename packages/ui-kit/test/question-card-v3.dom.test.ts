// @vitest-environment happy-dom
// V3-03 (DOM): the question card of the v3 interview — «Почему советуем», «Решите за меня» and «Дальше решай сам» appear
// only with their props and call them; without the props the v2 card renders exactly as before.
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { QuestionCard } from "../src/v2/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(el: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(el));
  const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { container, $, rerender: (n: ReactNode) => act(async () => root.render(n)) };
}

const click = (el: Element) => act(async () => void (el as HTMLElement).click());

afterEach(() => {
  document.body.innerHTML = "";
});

const base = {
  step: "Вопрос 3",
  question: "Какие данные пациента нужны для записи?",
  options: [
    { id: "o1", label: "Имя и телефон", recommended: true },
    { id: "o2", label: "Имя, телефон и почта" },
    { id: "o3", label: "Только телефон" },
  ],
  selected: [] as string[],
  onToggle: () => {},
};

describe("QuestionCard of the v3 interview", () => {
  test("why the recommendation, «Решите за меня», «Дальше решай сам»: shown with their props and called on press", async () => {
    const onDelegate = vi.fn();
    const onFinish = vi.fn();
    const r = await render(
      h(QuestionCard, {
        ...base,
        recommendationWhy: "Имени и телефона хватает, чтобы подтвердить запись.",
        onDelegate,
        onFinish,
      }),
    );
    expect(r.$("p-question-why")?.textContent).toBe(
      "Почему советуем: Имени и телефона хватает, чтобы подтвердить запись.",
    );
    expect(r.$("p-question-delegate")?.textContent).toBe("Решите за меня");
    expect(r.$("p-question-finish")?.textContent).toBe("Дальше решай сам");
    await click(r.$("p-question-delegate") as HTMLElement);
    await click(r.$("p-question-finish") as HTMLElement);
    expect(onDelegate).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    await r.rerender(h(QuestionCard, { ...base, onDelegate, onFinish, assistDisabled: true }));
    expect((r.$("p-question-delegate") as HTMLButtonElement).disabled).toBe(true);
    expect((r.$("p-question-finish") as HTMLButtonElement).disabled).toBe(true);
    expect(r.$("p-question-why")).toBeNull();
  });

  test("only one of the buttons when only its prop is given", async () => {
    const r = await render(h(QuestionCard, { ...base, onFinish: () => {} }));
    expect(r.$("p-question-delegate")).toBeNull();
    expect(r.$("p-question-finish")).not.toBeNull();
  });

  test("without the new props the v2 card is the same markup as before", () => {
    const v2 = { ...base, onSubmit: () => {} };
    const html = renderToStaticMarkup(h(QuestionCard, v2));
    expect(html).not.toContain("p-question-assist");
    expect(html).not.toContain("p-question-why");
    expect(html).not.toContain("Решите за меня");
    expect(
      renderToStaticMarkup(h(QuestionCard, { ...v2, recommendationWhy: undefined, onDelegate: undefined })),
    ).toBe(html);
  });
});
