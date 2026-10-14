// V4-23: the draft's blog is the owner's — the demo seed brings no «Статья 1» articles (the acceptance rehearsal's
// clinic showed «Статья 1, Статья 2, Статья 4» on the home page); titles the brief names keep their articles.
import { expect, test } from "vitest";
import { withoutDemoArticles } from "../src/agents/draft.js";

test("demo articles are dropped unless their titles are given; other entities stay", () => {
  const rows: Record<string, Record<string, string>[]> = {
    article: [{ title: "Статья 1" }],
    service: [{ name: "Терапия" }],
  };
  expect(withoutDemoArticles(rows, [])).toEqual({ service: [{ name: "Терапия" }] });
  const titles = { entity: "article", field: "title", values: ["Как подготовиться к визиту"] };
  expect(withoutDemoArticles(rows, [titles])).toEqual(rows);
  expect(withoutDemoArticles(rows, [{ entity: "service", field: "name", values: ["Терапия"] }])).toEqual({
    service: [{ name: "Терапия" }],
  });
});
