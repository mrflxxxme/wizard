// V3-22: the CLI of .github/workflows/integrations-sandbox.yml as the workflow runs it (node + tsx), without the
// network — ЮKassa without keys is a warning with what to do, a live key is refused before any request and never
// printed, a passport without a test contour or a wrong argument is a usage error; the step summary is written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "wz-sandbox-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The CLI with only the given env (no proxy, no keys of the machine). */
function cli(args, env = {}) {
  const summary = join(dir, `summary-${Math.random().toString(36).slice(2)}.md`);
  const r = spawnSync(process.execPath, [join(ROOT, "tools/integrations/sandbox-check.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_STEP_SUMMARY: summary, ...env },
    timeout: 60_000,
  });
  let written = "";
  try {
    written = readFileSync(summary, "utf8");
  } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, summary: written };
}

describe("tools/integrations/sandbox-check.mjs", () => {
  it("ЮKassa without keys: one warning line, exit 0, the summary table", () => {
    const r = cli(["--passports=yookassa"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      expect.stringMatching(
        /^::warning title=ЮKassa · keys::нет тестового магазина: создайте его в личном кабинете ЮKassa и положите ключи в секреты YOOKASSA_TEST_SHOP_ID и YOOKASSA_TEST_SECRET_KEY/,
      ),
    ]);
    expect(r.summary).toContain("## Паспорта API на тестовых контурах (V3-22)");
    expect(r.summary).toContain("| ЮKassa | keys | пропущен | — |");
  }, 60_000);

  it("a live ЮKassa key is refused before any request and never printed", () => {
    const key = `live_${"k".repeat(12)}Zq9`;
    const r = cli(["--passports=yookassa"], {
      YOOKASSA_TEST_SHOP_ID: "506751",
      YOOKASSA_TEST_SECRET_KEY: key,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /^::error title=ЮKassa · keys::YOOKASSA_TEST_SECRET_KEY — не ключ тестового магазина/,
    );
    expect(`${r.out}${r.err}${r.summary}`).not.toContain(key);
  }, 60_000);

  it("usage errors: a passport without a test contour, an unknown argument", () => {
    const tg = cli(["--passports=telegram"]);
    expect(tg.code).toBe(2);
    expect(tg.out.trim()).toBe(
      "::error title=Паспорта API · тестовые контуры::у паспорта «Telegram Bot API» нет тестового контура: проверяются только СДЭК, ЮKassa",
    );
    const bad = cli(["--all"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("неизвестный аргумент --all");
  }, 60_000);
});
