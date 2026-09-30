import { expect, test } from "vitest";
test("self ref", async () => {
  const m = await import("./.generated/probe/m.ts");
  expect(m.k).toBe("string");
});
