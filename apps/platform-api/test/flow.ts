import { expect } from "vitest";
import { type TestApi, waitRun } from "./helpers.js";

/** createSystem → questions → answers (by recommendation) → card. */
export async function toCard(api: TestApi, prompt = "Регистрация на форум на 600 участников") {
  const created = await api.req("POST", "/systems", { body: { prompt } });
  expect(created.status).toBe(201);
  const systemId: string = created.body.system.id;
  await waitRun(api, created.body.run.id, ["succeeded"]);
  const ans = await api.req("POST", `/systems/${systemId}/answers`, { body: { restByRecommendation: true } });
  expect(ans.status).toBe(202);
  await waitRun(api, ans.body.run.id, ["succeeded"]);
  const sys = await api.req("GET", `/systems/${systemId}`);
  expect(sys.body.system.stage).toBe("card");
  return {
    systemId,
    cardVersion: sys.body.card.cardVersion as number,
    createRunId: created.body.run.id as string,
  };
}

/** toCard → approve → build run id. */
export async function startBuild(api: TestApi, prompt?: string, capCredits?: number) {
  const c = await toCard(api, prompt);
  const ap = await api.req("POST", `/systems/${c.systemId}/card/approve`, {
    body: { cardVersion: c.cardVersion, ...(capCredits ? { capCredits } : {}) },
  });
  expect(ap.status).toBe(202);
  return { ...c, buildRunId: ap.body.run.id as string };
}
