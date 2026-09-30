// @vitest-environment happy-dom
// S2 «Как я понял задачу»: forks read as human titles, never raw ids (FU-4).
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import type { Message, Question } from "../src/api/types.js";
import { Understanding } from "../src/screens/workspace/Understanding.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
afterEach(() => container?.remove());

const message = (forks: Record<string, unknown>[]): Message => ({
  id: "1",
  seq: 1,
  role: "assistant",
  kind: "questions",
  text: "Есть 1 вопрос",
  payload: {
    questionIds: ["q1"],
    analysis: { title: "Форум", roles: [], skeleton: [], constraints: [], forks },
  },
  createdAt: "2026-09-30T10:00:00.000Z",
});

const question = { id: "q1", forkId: "F-LOGIN", text: "Как входить в систему?" } as Question;

function render(messages: Message[], questions: Question[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(h(Understanding, { messages, analyzing: false, questions })));
  return [...container.querySelectorAll('[data-testid="forks-list"] li')].map((li) => li.textContent ?? "");
}

test("resolved → title and option; asking → question; pending → title; no F-… ids", () => {
  const rows = render(
    [
      message([
        { forkId: "F-EV-TICKETS", status: "resolved", title: "Типы билетов", choice: "типы с лимитами" },
        { forkId: "F-LOGIN", status: "asking", title: "Способ входа" },
        { forkId: "F-VISIBILITY", status: "pending", title: "Кто что видит", choice: "все видят всё" },
      ]),
    ],
    [question],
  );
  expect(rows[0]).toContain("Типы билетов — типы с лимитами");
  expect(rows[1]).toContain("Как входить в систему?");
  expect(rows[2]).toContain("Кто что видит");
  for (const r of rows) expect(r).not.toMatch(/F-[A-Z]/);
});

test("old payloads without titles still hide raw ids", () => {
  const rows = render([message([{ forkId: "F-ACCESS", status: "resolved" }])], []);
  expect(rows[0]).not.toMatch(/F-ACCESS/);
});
