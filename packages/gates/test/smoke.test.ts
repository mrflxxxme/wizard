import { expect, test } from "vitest";
import { PACKAGE } from "../src/index.js";

test("package loads", () => {
  expect(PACKAGE).toBe("@wizard/gates");
});
