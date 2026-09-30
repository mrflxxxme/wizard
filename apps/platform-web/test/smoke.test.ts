import { expect, test } from "vitest";
import { APP } from "../src/index.js";

test("app loads", () => {
  expect(APP).toBe("@wizard/platform-web");
});
