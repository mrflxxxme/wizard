// V4-11: the words and the action of a failure on the canvas — ours by the code, the server's only when they are words,
// never a code or a stack; «Исправить» after failed checks, «Пополнить баланс» for money, nothing when pressing again
// cannot help.
import { expect, test } from "vitest";
import { errorWords, failureAction, failureText, isBillingError } from "../src/screens/canvas/failure.js";

test("actions by code", () => {
  expect(failureAction("LLM_UNAVAILABLE")).toBe("retry");
  expect(failureAction("RUN_TIMEOUT")).toBe("retry");
  expect(failureAction("GATES_FAILED")).toBe("fix");
  expect(failureAction("CONSECUTIVE_ERRORS")).toBe("fix");
  expect(failureAction("INSUFFICIENT_CREDITS")).toBe("billing");
  expect(failureAction("PLAN_INVALID")).toBeNull();
  expect(failureAction("LLM_BUDGET_EXHAUSTED")).toBeNull();
  expect(failureAction("NEVER_SEEN")).toBe("retry");
  expect(isBillingError("BUILDS_LIMIT")).toBe(true);
  expect(isBillingError(null)).toBe(false);
});

test("words: ours by the code, the server's when they are words, else the generic line", () => {
  expect(failureText("LLM_UNAVAILABLE", "upstream 502", "g")).toContain("Модели сейчас недоступны");
  expect(failureText("X_Y", "Не удалось прочитать файл таблицы", "g")).toBe(
    "Не удалось прочитать файл таблицы",
  );
  expect(failureText("X_Y", "STAGE_FAILED at compile", "g")).toBe("g");
  expect(failureText("X_Y", "TypeError: x is undefined", "g")).toBe("g");
  expect(failureText("X_Y", "", "g")).toBe("g");
  expect(errorWords("RATE_LIMITED", "Слишком много запросов — попробуйте через минуту")).toBe(
    "Слишком много запросов — попробуйте через минуту",
  );
});

test("a request's error: the server's words first, ours by the code when they are not words", () => {
  expect(errorWords("LLM_UNAVAILABLE", "Сервис перегружен")).toBe("Сервис перегружен");
  expect(errorWords("LLM_UNAVAILABLE", "LLM_UNAVAILABLE: upstream")).toContain("Модели сейчас недоступны");
});
