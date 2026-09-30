// @vitest-environment happy-dom
// Chat feed: LLM text only as text (L3-17); one PII notice per session with category words, never values.
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import type { Message } from "../src/api/types.js";
import { ChatFeed } from "../src/screens/workspace/ChatFeed.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
afterEach(() => container?.remove());

function render(messages: Message[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(h(ChatFeed, { messages })));
  return container;
}

const at = "2026-09-30T10:00:00.000Z";

test("assistant text with HTML is rendered as text; masked user text is shown; one notice", () => {
  const el = render([
    {
      id: "1",
      seq: 1,
      role: "user",
      kind: "text",
      text: "Звоните +7 912 345 45 10",
      payload: { maskedText: "Звоните +7 912 ••• 45 10" },
      createdAt: at,
    },
    {
      id: "2",
      seq: 2,
      role: "system",
      kind: "notice",
      payload: { type: "pii", categories: ["phone", "fio"] },
      createdAt: at,
    },
    {
      id: "3",
      seq: 3,
      role: "assistant",
      kind: "text",
      text: '<img src=x onerror="alert(1)"><b>жирный</b>',
      createdAt: at,
    },
    {
      id: "4",
      seq: 4,
      role: "system",
      kind: "notice",
      payload: { type: "pii", categories: ["email"] },
      createdAt: at,
    },
  ]);
  expect(el.querySelectorAll("img, b")).toHaveLength(0);
  expect(el.textContent).toContain('<img src=x onerror="alert(1)"><b>жирный</b>');
  expect(el.textContent).not.toContain("345 45 10");
  const notices = el.querySelectorAll('[data-testid="chat-pii-notice"]');
  expect(notices).toHaveLength(1);
  expect(notices[0]?.getAttribute("role")).toBe("note");
  expect(notices[0]?.textContent).toContain("(телефон, ФИО)");
  expect(el.querySelectorAll('[data-testid="chat-message"]')).toHaveLength(2);
});
