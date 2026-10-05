// Playwright acceptance of M0-16 (platform-screens.yaml S1–S6, preview_contract) against the mock API and the
// recorded feeds «форум». Test ids seen across the suites are checked against the spec at the end.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness, toBuilding, toCard, waitStage } from "./helpers/harness.js";
import { loadFeed } from "./mock/server.js";

const forum = loadFeed("forum");
const PHONE_BRIEF = `${forum.brief} Контакт организатора: +7 912 345 45 10.`;
const seen = new Set<string>();

async function collect(page: Page): Promise<void> {
  for (const id of await page.$$eval("[data-testid]", (els) =>
    els.map((e) => e.getAttribute("data-testid") ?? ""),
  ))
    seen.add(id);
}

async function previewFrame(page: Page): Promise<Frame> {
  await page.getByTestId("preview-frame").waitFor({ timeout: 20_000 });
  const handle = await page.getByTestId("preview-frame").elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("no preview frame");
  await frame.getByTestId("stub-nav").waitFor({ timeout: 20_000 });
  return frame;
}

async function navItems(frame: Frame): Promise<string[]> {
  return frame.getByTestId("stub-nav-item").allTextContents();
}

describe.skipIf(!hasChromium)("platform-web in chromium (fixture «форум»)", () => {
  let h: Harness;
  let page: Page;
  let systemId = "";
  beforeAll(async () => {
    h = await startHarness({ feed: forum, eventDelayMs: 20, orgSettings: { buildModelLabel: "GLM-5.3" } });
    page = await h.page();
  }, 120_000);
  afterAll(async () => h?.close());

  test("S1: policy label from settings, templates, disabled submit, no horizontal scroll at 1024px", async () => {
    await expect.poll(() => page.getByTestId("start-policy").textContent()).toContain("Сборка: GLM-5.3");
    expect(await page.getByTestId("start-submit").isDisabled()).toBe(true);
    await page.getByTestId("start-template-event_registration").click();
    expect(await page.getByTestId("start-prompt").inputValue()).toContain("Мероприятие");
    expect(await page.getByTestId("start-submit").isDisabled()).toBe(false);
    await page.getByTestId("start-prompt").fill("");
    expect(await page.getByTestId("start-submit").isDisabled()).toBe(true);
    await page.setViewportSize({ width: 1024, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await collect(page);
  });

  test("S1 → S2: brief «форум» with a phone → /s/<id>, user message, exactly one PII notice without the value", async () => {
    await page.getByTestId("start-prompt").fill(PHONE_BRIEF);
    await page.getByTestId("start-submit").click();
    await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
    systemId = page.url().split("/s/")[1] as string;
    await expect.poll(() => page.getByTestId("chat-message").count()).toBeGreaterThan(0);
    expect(await page.getByTestId("chat-message").first().textContent()).toContain("Северный ритейл");
    await page.getByTestId("chat-pii-notice").waitFor();
    expect(await page.getByTestId("chat-pii-notice").count()).toBe(1);
    const notice = (await page.getByTestId("chat-pii-notice").textContent()) ?? "";
    expect(notice).toContain("телефон");
    expect(notice).not.toContain("345 45 10");
    expect(await page.locator("body").textContent()).not.toContain("345 45 10");
  });

  test("S2: 3–7 questions, one recommended each and selected by default; answers go in one POST", async () => {
    await page.getByTestId("question-card").waitFor();
    await page.getByTestId("understanding-panel").waitFor();
    expect(await page.getByTestId("forks-list").locator("li").count()).toBeGreaterThan(0);
    await collect(page);
    const n = forum.interview.questions.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(7);
    for (let i = 0; i < n; i++) {
      const q = forum.interview.questions[i];
      expect(await page.getByTestId("question-progress").textContent()).toBe(`Вопрос ${i + 1} из ${n}`);
      expect(await page.getByTestId("question-recommended").count()).toBe(1);
      const rec = q?.options.find((o) => o.recommended);
      expect(await page.getByTestId(`question-option-${rec?.id}`).locator("input").isChecked()).toBe(true);
      await collect(page);
      if (i === 1) {
        // An explicit non-recommended choice on the second question.
        const other = q?.options.find((o) => !o.recommended);
        await page.getByTestId(`question-option-${other?.id}`).click();
      }
      await page.getByTestId("question-next").click();
    }
    await page.getByTestId("card").waitFor();
    const posts = h.mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/answers"));
    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as {
      answers: { questionId: string; optionId?: string }[];
      restByRecommendation?: boolean;
    };
    expect(body.answers).toHaveLength(n);
    expect(body.restByRecommendation).toBeUndefined();
    expect(posts[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("S3: estimate, cap, ≥ 6 criteria; an edit gives version N+1 and «Карточка обновлена»; «Строить» approves it", async () => {
    expect(await page.getByTestId("card-estimate").textContent()).toMatch(/примерно \d+–\d+ минут/);
    expect(await page.getByTestId("card-cap").textContent()).toContain("На пилоте бесплатно");
    expect(await page.getByTestId("card-cap").textContent()).toContain("GLM-5.3");
    expect(await page.getByTestId("card-acceptance-item").count()).toBeGreaterThanOrEqual(6);
    expect(await page.getByTestId("card-version").textContent()).toContain("версия 1");
    await collect(page);
    await page.getByTestId("card-edit").click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("chat-input");
    await page.getByTestId("chat-input").fill("добавь лист ожидания VIP");
    await page.getByTestId("chat-send").click();
    await expect.poll(() => page.getByTestId("card-version").textContent()).toContain("версия 2");
    await page.getByTestId("card-updated").waitFor();
    expect(await page.getByTestId("card-updated").textContent()).toBe("Карточка обновлена");
    await page.getByTestId("card-build").click();
    await page.getByTestId("build-progress").waitFor();
    const approve = h.mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/card/approve"));
    expect(approve?.body).toEqual({ cardVersion: 2 });
  });

  test("S4: steps ✓, G0 passed, preview loaded; role switch changes preview navigation and keeps the route", async () => {
    await expect
      .poll(() => page.getByTestId("gate-row-G0").getAttribute("data-status"), { timeout: 20_000 })
      .toBe("passed");
    const frame = await previewFrame(page);
    await collect(page);
    await expect
      .poll(() => page.getByTestId("gate-row-G2").getAttribute("data-status"), { timeout: 20_000 })
      .toBe("passed");
    const statuses = await page
      .getByTestId("build-step")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    expect(statuses.length).toBe(6);
    expect(new Set(statuses)).toEqual(new Set(["done"]));
    expect(await page.getByTestId("build-model-notice").count()).toBe(1);
    expect(await page.getByTestId("agent-message").count()).toBeGreaterThan(0);
    // D70: no credits in the build log.
    expect(await page.getByTestId("build-progress").textContent()).not.toMatch(/кредит/i);
    await collect(page);

    const participant = forum.pages.filter((p) => p.roles.includes("participant") && !p.route.includes(":"));
    await page.getByTestId("role-switch-participant").click();
    await expect.poll(() => navItems(frame)).toEqual(participant.map((p) => p.title));
    const organizer = forum.pages.filter((p) => p.roles.includes("organizer") && !p.route.includes(":"));
    await page.getByTestId("role-switch-organizer").click();
    await expect.poll(() => navItems(frame)).toEqual(organizer.map((p) => p.title));
    await frame.getByTestId("stub-nav-item").filter({ hasText: "Модерация заявок" }).click();
    await expect.poll(() => frame.getByTestId("stub-route").textContent()).toBe("/moderation");
    await page.getByTestId("role-switch-moderator").click();
    await expect.poll(() => h.mock.previewRole).toBe("moderator");
    await expect.poll(() => frame.getByTestId("stub-route").textContent()).toBe("/moderation");
    expect(await page.getByTestId("role-switch-moderator").getAttribute("aria-pressed")).toBe("true");

    // run_finished re-reads the system, whose previewRevision now equals the G0 revision already shown: that is
    // not growth, so after the 1 s reload debounce the same iframe is still mounted (FU-3).
    await page.getByTestId("gate-report").waitFor();
    const logins = h.mock.previewLogins;
    await new Promise((r) => setTimeout(r, 1500));
    expect(frame.isDetached()).toBe(false);
    expect(h.mock.previewLogins).toBe(logins);
    expect(await frame.getByTestId("stub-route").textContent()).toBe("/moderation");
  });

  test("S4: preview width switch changes the iframe width without reload", async () => {
    const frame = page.getByTestId("preview-frame");
    const logins = h.mock.previewLogins;
    await page.getByTestId("preview-width-390").click();
    await expect.poll(async () => (await frame.boundingBox())?.width).toBe(390);
    await page.getByTestId("preview-width-1280").click();
    expect(h.mock.previewLogins).toBe(logins);
  });

  test("S5: accent change reaches the preview < 300 ms without /runs requests or iframe reload; saved after reload", async () => {
    await page.getByTestId("style-toggle").click();
    await page.getByTestId("style-panel").waitFor();
    await collect(page);
    const frame = await previewFrame(page);
    let navigations = 0;
    page.on("framenavigated", (f) => {
      if (f !== page.mainFrame()) navigations++;
    });
    const runRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/runs")) runRequests.push(r.url());
    });
    await frame.evaluate(() => {
      (window as unknown as { marker: number }).marker = 7;
    });
    const before = await frame.getByTestId("stub-cta").evaluate((b) => getComputedStyle(b).backgroundColor);
    expect(before).not.toBe("rgb(10, 125, 62)");
    // Latency is measured inside the browser (click event → the preview repaints the accent) on the shared
    // performance.timeOrigin clock, so Playwright's actionability checks and IPC on a loaded CI do not count.
    await page.evaluate(() => {
      const w = window as unknown as { clickAt?: number };
      document.addEventListener(
        "click",
        (e) => {
          if ((e.target as Element).closest('[data-testid="style-accent-0a7d3e"]'))
            w.clickAt ??= performance.timeOrigin + e.timeStamp;
        },
        true,
      );
    });
    await frame.evaluate(() => {
      const w = window as unknown as { appliedAt?: number };
      const cta = document.querySelector('[data-testid="stub-cta"]') as Element;
      new MutationObserver(() => {
        if (getComputedStyle(cta).backgroundColor === "rgb(10, 125, 62)")
          w.appliedAt ??= performance.timeOrigin + performance.now();
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    });
    await page.getByTestId("style-accent-0a7d3e").click();
    await expect
      .poll(() => frame.getByTestId("stub-cta").evaluate((b) => getComputedStyle(b).backgroundColor))
      .toBe("rgb(10, 125, 62)");
    const clickAt = await page.evaluate(
      () => (window as unknown as { clickAt?: number }).clickAt ?? Number.NaN,
    );
    const appliedAt = await frame.evaluate(
      () => (window as unknown as { appliedAt?: number }).appliedAt ?? Number.NaN,
    );
    expect(appliedAt - clickAt).toBeGreaterThanOrEqual(0);
    expect(appliedAt - clickAt).toBeLessThan(300);
    expect(await frame.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(7);
    await expect.poll(() => page.getByTestId("style-status").textContent()).toBe("Сохранено");
    expect(navigations).toBe(0);
    expect(runRequests).toEqual([]);
    const style = h.mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/style"));
    expect((style?.body as { theme: { accent: string } } | undefined)?.theme.accent).toBe("#0A7D3E");

    await page.reload();
    await page.getByTestId("style-panel").waitFor();
    expect(await page.getByTestId("style-accent-0a7d3e").getAttribute("aria-pressed")).toBe("true");
    const again = await previewFrame(page);
    await expect
      .poll(() => again.getByTestId("stub-cta").evaluate((b) => getComputedStyle(b).backgroundColor))
      .toBe("rgb(10, 125, 62)");
    await collect(page);
  });

  test("S5 (M2-42): a theme preset keeps the brand colour, reaches the preview and is saved with /style", async () => {
    await page.getByTestId("style-panel").waitFor();
    const frame = await previewFrame(page);
    await page.getByTestId("style-preset-warm").click();
    expect(await page.getByTestId("style-preset-warm").getAttribute("aria-pressed")).toBe("true");
    await expect
      .poll(() => frame.evaluate(() => document.documentElement.style.getPropertyValue("--w-bg")))
      .toBe("#FBF6F0");
    expect(
      await frame.evaluate(() => document.documentElement.style.getPropertyValue("--w-font-heading")),
    ).toContain("Lora");
    expect(await page.getByTestId("style-heading-font").inputValue()).toBe("Lora");
    await expect.poll(() => page.getByTestId("style-status").textContent()).toBe("Сохранено");
    const saved = h.mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/style")).at(-1);
    expect((saved?.body as { theme: Record<string, unknown> } | undefined)?.theme).toMatchObject({
      preset: "warm",
      accent: "#0A7D3E",
    });
  });

  test("S6: three gate rows passed, non-blocking warning, publish enabled for the owner without blockers", async () => {
    await waitStage(h, systemId, "ready");
    await page.getByTestId("gate-report").waitFor();
    for (const l of ["G0", "G1", "G2"])
      expect(await page.getByTestId(`gate-report-row-${l}`).getAttribute("data-passed")).toBe("true");
    expect(await page.getByTestId("gate-warning").count()).toBeGreaterThan(0);
    expect(await page.getByTestId("publish-blocker").count()).toBe(0);
    await expect.poll(() => page.getByTestId("publish-submit").isDisabled()).toBe(false);
    await collect(page);
    await page.goto(`${h.origin}/`);
    await page.getByTestId("start-system-card").first().waitFor();
    await collect(page);
  });

  test("bridge: an error from the preview is shown as text; a longer than 300 chars one and a foreign source are ignored", async () => {
    await page.goto(`${h.origin}/s/${systemId}`);
    const frame = await previewFrame(page);
    await page.evaluate(() =>
      window.postMessage({ wz: 1, type: "error", payload: { message: "чужой источник" } }, "*"),
    );
    await frame.evaluate(() =>
      window.parent.postMessage({ wz: 1, type: "error", payload: { message: "x".repeat(301) } }, "*"),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(await page.getByTestId("preview-error").count()).toBe(0);
    await frame.evaluate(() =>
      window.parent.postMessage(
        { wz: 1, type: "error", payload: { message: '<img src=x data-evil="1"> Ошибка <b>рендера</b>' } },
        "*",
      ),
    );
    await page.getByTestId("preview-error").waitFor();
    expect(await page.getByTestId("preview-error").textContent()).toContain("<img src=x");
    expect(await page.locator("[data-evil]").count()).toBe(0);
  });
});

describe.skipIf(!hasChromium)("S2 «Остальное — по рекомендациям» on the first question", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ feed: forum, eventDelayMs: 10 });
  }, 120_000);
  afterAll(async () => h?.close());

  test("one POST answers with restByRecommendation=true → S3", async () => {
    const page = await h.page();
    await page.getByTestId("start-prompt").fill("Форум на 600 человек с билетами");
    await page.getByTestId("start-submit").click();
    await page.getByTestId("question-card").waitFor();
    await page.getByTestId("question-accept-rest").click();
    await page.getByTestId("card").waitFor();
    const posts = h.mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/answers"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ answers: [], restByRecommendation: true });
  });
});

describe.skipIf(!hasChromium)("budget fixture: cap below spend", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ feed: forum, eventDelayMs: 20, variant: "budget" });
  }, 120_000);
  afterAll(async () => h?.close());

  test("budget-exceeded + needs-input-decision; no new step_started without an answer; the answer resumes", async () => {
    const id = await toBuilding(h);
    const page = await h.page({ path: `/s/${id}` });
    await page.getByTestId("budget-exceeded").waitFor({ timeout: 20_000 });
    await page.getByTestId("needs-input-decision").waitFor();
    await collect(page);
    expect(await page.getByTestId("budget-exceeded").getAttribute("role")).toBe("alert");
    const run = [...h.mock.runs.values()].find((r) => r.run.kind === "build");
    const started = () => run?.events.filter((e) => e.type === "step_started").length ?? 0;
    const n = started();
    const running = await page.locator('[data-testid="build-step"][data-status="running"]').count();
    await new Promise((r) => setTimeout(r, 1200));
    expect(started()).toBe(n);
    expect(await page.locator('[data-testid="build-step"][data-status="running"]').count()).toBe(running);
    expect(await page.getByTestId("needs-input-option-raise_cap_2").locator("input").isChecked()).toBe(true);
    await page.getByTestId("needs-input-decision").getByRole("button").click();
    await expect.poll(() => page.getByTestId("needs-input-decision").count()).toBe(0);
    expect(await page.getByTestId("budget-exceeded").count()).toBe(0);
    await expect.poll(() => started(), { timeout: 10_000 }).toBeGreaterThan(n);
    const input = h.mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/input"));
    expect(input?.body).toEqual({ inputId: "budget-1", choice: "raise_cap_2" });
  });
});

describe.skipIf(!hasChromium)("SSE break and reload", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ feed: forum, eventDelayMs: 100 });
  }, 120_000);
  afterAll(async () => h?.close());

  test("connection lost for 1 s → after reconnect the steps have no duplicates", async () => {
    const id = await toBuilding(h);
    const page = await h.page({ path: `/s/${id}` });
    await expect.poll(() => page.getByTestId("build-step").count(), { timeout: 10_000 }).toBe(6);
    await expect
      .poll(() => page.locator('[data-testid="build-step"][data-status="done"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.route("**/runs/*/events*", (r) => r.abort());
    h.mock.dropStreams();
    await new Promise((r) => setTimeout(r, 1000));
    await page.unroute("**/runs/*/events*");
    await expect
      .poll(() => page.getByTestId("gate-row-G2").getAttribute("data-status"), { timeout: 30_000 })
      .toBe("passed");
    expect(await page.getByTestId("build-step").count()).toBe(6);
    const text = (await page.getByTestId("build-plan").textContent()) ?? "";
    for (const f of ["ui/Landing.tsx", "functions/registerTicket.ts"])
      expect(text.split(f).length - 1).toBe(1);
    expect(await page.getByTestId("agent-message").count()).toBe(
      forum.build.filter((e) => e.type === "agent_message").length,
    );
  }, 60_000);
});

describe.skipIf(!hasChromium)("failed G1 and failed build fixtures", () => {
  test("failed G1 → publish-submit disabled, publish-blocker names the scenario check in words", async () => {
    const h = await startHarness({ feed: forum, eventDelayMs: 5, variant: "failG1" });
    try {
      const id = await toBuilding(h);
      await waitStage(h, id, "ready");
      const page = await h.page({ path: `/s/${id}` });
      await expect
        .poll(() => page.getByTestId("publish-blocker").first().textContent())
        .toContain("Проверка сценариев работы");
      expect(await page.getByTestId("publish-submit").isDisabled()).toBe(true);
      expect(await page.getByTestId("gate-report-row-G1").getAttribute("data-passed")).toBe("false");
      await collect(page);
    } finally {
      await h.close();
    }
  });

  test("run_failed → run-error (role=alert) and «Исправить» → POST /fix", async () => {
    const h = await startHarness({ feed: forum, eventDelayMs: 5, variant: "failBuild" });
    try {
      const id = await toBuilding(h);
      const page = await h.page({ path: `/s/${id}` });
      await page.getByTestId("run-error").waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("run-error").getAttribute("role")).toBe("alert");
      await collect(page);
      await page.getByTestId("run-fix").click();
      await expect.poll(() => h.mock.countRequests("POST", /\/fix$/)).toBe(1);
      await waitStage(h, id, "ready");
    } finally {
      await h.close();
    }
  });
});

describe.skipIf(!hasChromium)("S1–S6 test ids of platform-screens.yaml", () => {
  test("every M0 test id was rendered (M3 «укажи и измени» and M1 secret form excluded)", () => {
    const doc = parse(readFileSync(join(APP_ROOT, "../../specs/ui/platform-screens.yaml"), "utf8")) as {
      screens: { id: string; test_ids: string[] }[];
      pii_notice: { test_ids: string[] };
    };
    const ids = [
      ...doc.screens
        .filter((s) => ["S1", "S2", "S3", "S4", "S5", "S6"].includes(s.id))
        .flatMap((s) => s.test_ids),
      ...doc.pii_notice.test_ids,
    ].filter((id) => !id.startsWith("select-") && id !== "secret-request");
    const missing = ids.filter((id) => {
      const m = /^(.*)<[^>]+>$/.exec(id);
      return m ? ![...seen].some((x) => x.startsWith(m[1] as string)) : !seen.has(id);
    });
    expect(missing).toEqual([]);
  });
});

void toCard;
