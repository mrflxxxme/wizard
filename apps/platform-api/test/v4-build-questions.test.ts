// V4-08: the interview's deferred (non-blocking) questions reach the v3 build as questions with the assumption taken
// meanwhile — one option, recommended, a stable id per question text (asked once per system).
import { expect, test } from "vitest";
import { deferredAsBuildQuestions } from "../src/builds-v3/host.js";

test("deferred questions become build questions with their assumption as the default", () => {
  const qs = deferredAsBuildQuestions([
    { topic: "audience", text: "Кто ваши клиенты?", assumption: "Взрослые жители района" },
    { topic: "content", text: "Нужен ли блог?", assumption: "Пока без блога" },
    { topic: "audience", text: "Кто ваши клиенты?", assumption: "дубль" },
  ]);
  expect(qs).toHaveLength(2);
  expect(qs[0]).toMatchObject({
    text: "Кто ваши клиенты?",
    options: [{ id: "assumed", label: "Взрослые жители района" }],
    recommended: "assumed",
  });
  expect(qs[0]?.id).toMatch(/^deferred_[0-9a-f]{12}$/);
  expect(
    deferredAsBuildQuestions([{ topic: "content", text: "Нужен ли блог?", assumption: "x" }])[0]?.id,
  ).toBe(qs[1]?.id);
});
