// M2-14: a required file field the role writes itself — the G1 create probe uploads a real file (POST /api/files)
// instead of a seed placeholder, which the runtime refuses as a file value.
import type { Entity } from "@wizard/appspec";
import { afterAll, beforeAll, expect, test } from "vitest";
import { generatePermissionChecks, runGates } from "../src/index.js";
import { type G1Harness, g1Harness } from "./g1-helpers.js";
import { loadForum } from "./helpers.js";

let h: G1Harness;
beforeAll(async () => {
  h = await g1Harness();
});
afterAll(async () => {
  expect(await h.leftoverSchemas()).toBe(0);
  await h.close();
});

test("speaker creates an application with a required file: probes pass with an uploaded file", async () => {
  const spec = loadForum();
  const app = spec.entities.find((e) => e.name === "speaker_application") as Entity;
  app.fields.push({ name: "slides", label: "Презентация", type: "file", required: true });
  const r = await runGates("G1", h.ctx({ spec, checks: generatePermissionChecks(spec), milestone: "M2" }));
  const speaker = r.checks.filter((c) => c.id.startsWith("PC-speaker-speaker_application"));
  expect(speaker.map((c) => c.id)).toContain("PC-speaker-speaker_application-create");
  expect(
    speaker.filter((c) => c.status !== "pass"),
    JSON.stringify(speaker, null, 1).slice(0, 3000),
  ).toEqual([]);
}, 120_000);
