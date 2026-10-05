// Budget guard and live progress of the D67 measurement: fail-fast once the threshold is out of reach, a stop from
// outside (cancelled job) cancels the running build, and the progress comment in the GitHub issue.
import { describe, expect, it } from "vitest";
import { runEval } from "../server/driver.mjs";
import { githubProgress, PROGRESS_ISSUE_TITLE, progressText } from "../server/progress.mjs";

const briefs = Array.from({ length: 10 }, (_, i) => ({ id: `b${i + 1}`, title: `Бриф ${i + 1}`, text: "Сайт." }));
const noSleep = async () => {};

/** A client whose every brief fails at once (the platform refuses to create the system). */
const failingClient = () => {
  const calls = [];
  return {
    calls,
    base: "https://test",
    post: async (path) => {
      calls.push(path);
      throw new Error("сервер отказал");
    },
    get: async () => {
      throw new Error("нет");
    },
  };
};

describe("fail-fast: the D67 threshold out of reach stops the measurement", () => {
  it("after 4 of 10 lost (7 needed) the rest is skipped, no more systems are created", async () => {
    const client = failingClient();
    const lines = [];
    const doc = await runEval({ client, briefs, concurrency: 1, sleep: noSleep, log: (l) => lines.push(l) });
    expect(client.calls.filter((p) => p === "/systems")).toHaveLength(4);
    expect(doc.results.slice(0, 4).every((r) => r.status === "error")).toBe(true);
    expect(doc.results.slice(4).every((r) => r.status === "skipped")).toBe(true);
    expect(doc.stopped).toMatch(/порог 7 из 10 уже недостижим/);
    expect(lines.some((l) => l.includes("::warning title=D67::замер остановлен"))).toBe(true);
  });

  it("failFast: false runs every brief", async () => {
    const client = failingClient();
    const doc = await runEval({ client, briefs, concurrency: 2, sleep: noSleep, log: () => {}, failFast: false });
    expect(client.calls.filter((p) => p === "/systems")).toHaveLength(10);
    expect(doc.stopped).toBeNull();
  });

  it("a stop from outside cancels the running build and skips the rest", async () => {
    const stop = new AbortController();
    const posts = [];
    let polls = 0;
    const client = {
      base: "https://test",
      post: async (path, body) => {
        posts.push(path);
        if (path === "/systems") return { body: { system: { id: "s1" }, run: { id: "r1", kind: "interview_turn", status: "running" } } };
        return { body: {} };
      },
      get: async () => {
        polls += 1;
        if (polls === 2) stop.abort("задание отменено");
        return { body: { id: "r1", kind: "interview_turn", status: "running" } };
      },
      readEvents: async () => [],
    };
    const doc = await runEval({ client, briefs: briefs.slice(0, 3), concurrency: 1, sleep: noSleep, log: () => {}, signal: stop.signal });
    expect(posts).toContain("/runs/r1/cancel");
    expect(doc.results[0]?.status).toBe("error");
    expect(doc.results[0]?.error).toMatch(/замер остановлен: задание отменено/);
    expect(doc.results.slice(1).every((r) => r.status === "skipped")).toBe(true);
    expect(doc.stopped).toBe("задание отменено");
  });
});

describe("live progress in a GitHub issue", () => {
  const results = [
    { id: "b1", status: "ready", ready: true, minutes: 41.5, costRubEstimate: 120.4 },
    { id: "b2", status: "build_failed", ready: false, minutes: 60, costRubEstimate: 150, error: "проверки | не прошли" },
    { id: "b3", status: "running", ready: false, costRubEstimate: 12 },
  ];

  it("the comment: head, table, the last lines; pipes are escaped", () => {
    const t = progressText({
      runId: "r",
      runUrl: "https://x/runs/1",
      startedAt: "05.10.2026, 20:32",
      budgetRub: 1500,
      results,
      lines: ["20:33 b1: интервью"],
      stopped: null,
      finished: false,
    });
    expect(t).toContain("**Идёт.** Завершено 2 из 3, готовы 1.");
    expect(t).toContain("Расход ≈ 282 ₽ из 1500 ₽");
    expect(t).toContain("| b2 | ❌ сборка не удалась | 60 | 150 | проверки / не прошли |");
    expect(t).toContain("20:33 b1: интервью");
    expect(progressText({ runId: "r", startedAt: "", budgetRub: 1, results, lines: [], stopped: "порог недостижим", finished: true })).toContain(
      "Замер закончен (остановлен: порог недостижим)",
    );
  });

  it("creates the issue once, then one comment per run edited at most once a minute (or when forced)", async () => {
    const calls = [];
    let clock = 0;
    const fetch = async (url, init) => {
      const path = url.replace("https://api.github.com/repos/o/r", "");
      calls.push([init.method, path.split("?")[0]]);
      const json = (v, status = 200) => ({ ok: true, status, json: async () => v });
      if (init.method === "GET") return json([{ number: 3, title: "другое" }]);
      if (path === "/issues") return json({ number: 7, title: PROGRESS_ISSUE_TITLE }, 201);
      if (path === "/issues/7/comments") return json({ id: 99 }, 201);
      return json({});
    };
    const p = githubProgress({ token: "t", repo: "o/r", fetch, now: () => clock });
    await p.publish("a");
    clock += 10_000;
    await p.publish("b");
    clock += 10_000;
    await p.publish("c", { force: true });
    clock += 61_000;
    await p.publish("d");
    expect(calls).toEqual([
      ["GET", "/issues"],
      ["POST", "/issues"],
      ["POST", "/issues/7/comments"],
      ["PATCH", "/issues/comments/99"],
      ["PATCH", "/issues/comments/99"],
    ]);
  });

  it("no token — no publisher; API errors are one warning, never a failure", async () => {
    expect(githubProgress({ token: "", repo: "o/r" })).toBeNull();
    const logs = [];
    const p = githubProgress({
      token: "t",
      repo: "o/r",
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
      log: (l) => logs.push(l),
    });
    await p.publish("a", { force: true });
    await p.publish("b", { force: true });
    expect(logs).toEqual(["::warning::ход замера в issue не публикуется: GitHub API GET /issues: HTTP 403"]);
  });
});
