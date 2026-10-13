// V4-02: tools/specs/archive.mjs moves done tasks of finished milestones verbatim, keeps the active milestone and
// the section comments of tasks that stay; a second run moves nothing; validate.mjs sees every task once.
import { describe, expect, it } from "vitest";
import { archiveDone, splitBacklog } from "../archive.mjs";

const BACKLOG = `# header
tasks:
  # ---- M0 ----
  - id: M0-01
    milestone: M0
    status: done
    acceptance: ["a"]

  - id: M0-02
    milestone: M0
    status: todo
    acceptance: ["b"]
  # ---- V4 ----
  - id: V4-01
    milestone: V4
    status: done
    acceptance: ["c"]
`;

describe("archive.mjs", () => {
  it("moves done tasks outside the kept milestones, with their section comment", () => {
    const r = archiveDone(BACKLOG, "", new Set(["V4"]));
    expect(r.moved).toEqual(["M0-01"]);
    expect(r.backlog).toContain("  - id: M0-02");
    expect(r.backlog).toContain("  - id: V4-01");
    expect(r.backlog).not.toContain("  - id: M0-01");
    expect(r.archive).toContain("  # ---- M0 ----\n  - id: M0-01");
    expect(r.archive).toContain("\ntasks:\n");
    const again = archiveDone(r.backlog, r.archive, new Set(["V4"]));
    expect(again.moved).toEqual([]);
    expect(again.archive).toBe(r.archive);
  });

  it("splits sections and tasks in order", () => {
    const { items } = splitBacklog(BACKLOG);
    expect(items.map((i) => i.kind === "task" ? `${i.id}:${i.status}` : "§")).toEqual(["§", "M0-01:done", "M0-02:todo", "§", "V4-01:done"]);
  });
});
