// V3-19 in chromium, 390 and 1280 px × light and dark: the publication of a built v3 system on the canvas. The system
// keeps personal data, so the server asks the operator's data first (publishBlockers OPERATOR_*): the owner types it
// into the chat card (PUT /compliance with the draft revision, a new revision), «Опубликовать» turns on, the publish run
// streams over SSE (its step, then the end with the prod address), the card shows the published version, the site and
// the owner's cabinet. Settings are one tap away (top bar and card). No horizontal scroll; screenshots in
// test/artifacts/v3-publish-*.png.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { systemBriefSchema } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const PROD = "http://v3-dental.localhost:4100/";
const OPERATOR = ["OPERATOR_NAME_REQUIRED", "OPERATOR_CONTACT_REQUIRED", "OPERATOR_ADDRESS_REQUIRED"];
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** A built v3 system with personal data: compliance makes a revision, publish runs and puts it in prod. */
class BuiltV3 extends FakeV3 {
  draft = 5;
  prod: number | null = null;
  operator: Record<string, unknown> | null = null;
  readonly publishes: unknown[] = [];
  publishRun: string | null = null;

  // The base fake types an interview system (no revisions yet); a built one widens its fields.
  override system(stageOverride?: string): ReturnType<FakeV3["system"]> {
    return {
      ...super.system(stageOverride),
      stage: "ready",
      draftRevision: this.draft,
      previewRevision: 5,
      prodRevision: this.prod,
      prodUrl: this.prod === null ? null : PROD,
    } as unknown as ReturnType<FakeV3["system"]>;
  }

  override view(): ReturnType<FakeV3["view"]> {
    return { ...super.view(), publishBlockers: (this.operator ? [] : OPERATOR) as never[] };
  }

  override events(runId: string): string {
    if (runId !== this.publishRun) return super.events(runId);
    const ts = new Date().toISOString();
    const frames = [
      { type: "run_started", payload: { kind: "publish" } },
      { type: "step_started", payload: { step: "migrate_prod", label_ru: "Переношу данные" } },
      { type: "step_finished", payload: { step: "migrate_prod" } },
      {
        type: "run_finished",
        payload: { status: "succeeded", summary_ru: `Ревизия ${this.draft} опубликована`, prodUrl: PROD },
      },
    ].map((e, i) => ({ runId, seq: i + 1, ts, ...e }));
    this.prod = this.draft;
    return frames.map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  }
}

async function serveBuilt(page: Page, fake: BuiltV3): Promise<void> {
  await serveV3(page, fake);
  const base = `/api/v1/systems/${fake.systemId}`;
  await page.route(new RegExp(`${base}/gates/latest`), (route) =>
    json(route, 200, {
      revision: 5,
      reports: ["G0", "G1", "G2"].map((level) => ({ level, passed: level !== "G2", checks: [] })),
    }),
  );
  await page.route(new RegExp(`${base}/revisions(\\?.*)?$`), (route) =>
    json(route, 200, { items: [{ version: fake.draft, g0Passed: fake.draft === 5 ? true : null }] }),
  );
  await page.route(new RegExp(`${base}/revisions/\\d+$`), (route) =>
    json(route, 200, { version: fake.draft, spec: { compliance: fake.operator ?? {} } }),
  );
  await page.route(new RegExp(`${base}/compliance$`), (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.expectedVersion !== fake.draft)
      return json(route, 412, { code: "VERSION_CONFLICT", message_ru: "Версия устарела" });
    fake.operator = body;
    fake.draft += 1;
    return json(route, 200, { revision: { version: fake.draft } });
  });
  await page.route(new RegExp(`${base}/publish$`), (route) => {
    const body = route.request().postDataJSON();
    fake.publishes.push(body);
    fake.publishRun = randomUUID();
    return json(route, 202, {
      run: { id: fake.publishRun, kind: "publish", status: "queued", createdAt: new Date().toISOString() },
    });
  });
}

describe.skipIf(!hasChromium)("the publication of a v3 system on the canvas in chromium", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: the operator's data → «Опубликовать» → the site and the cabinet`, async () => {
        const tag = `${vp.width}-${scheme}`;
        const fake = new BuiltV3();
        fake.versions.push({
          version: 1,
          brief: systemBriefSchema.parse(dentalBrief()),
          diff: [],
          author: "agent",
          createdAt: new Date().toISOString(),
        });
        const page = await h.page({ viewport: vp, colorScheme: scheme, reducedMotion: "reduce" });
        await serveBuilt(page, fake);
        await page.goto(`${h.origin}/s/${fake.systemId}`);

        // The card of a built system: the operator's data asked in the chat, «Опубликовать» off, the settings near.
        const card = page.getByTestId("canvas-v3-publish");
        await card.waitFor({ timeout: 15_000 });
        expect(await page.getByTestId("canvas-settings").getAttribute("href")).toBe(
          `/s/${fake.systemId}/settings`,
        );
        const submit = page.getByTestId("canvas-v3-publish-submit");
        expect(await submit.isDisabled()).toBe(true);
        await page.getByTestId("canvas-v3-operator").waitFor();
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-publish-${tag}-1-operator.png`) });

        // A wrong e-mail is said before any request; then the data is saved with the draft revision.
        await page.getByTestId("canvas-v3-operator-name").fill("ИП Иванова А. А.");
        await page.getByTestId("canvas-v3-operator-contact").fill("почта");
        await page.getByTestId("canvas-v3-operator-save").click();
        expect(await page.getByTestId("canvas-v3-operator-error").textContent()).toBe(
          "Укажите e-mail в виде name@example.ru.",
        );
        expect(fake.operator).toBeNull();
        await page.getByTestId("canvas-v3-operator-contact").fill("privacy@dental.example");
        await page.getByTestId("canvas-v3-operator-address").fill("г. Москва, ул. Зубная, д. 1");
        await page.getByTestId("canvas-v3-operator-save").click();
        await expect.poll(() => fake.operator?.expectedVersion).toBe(5);
        await page.getByTestId("canvas-v3-operator").waitFor({ state: "detached" });

        // Nothing stops it now (the build's G2 report does not): «Опубликовать» publishes the operator's revision.
        await expect.poll(() => submit.isDisabled()).toBe(false);
        expect(await page.getByTestId("canvas-v3-publish-blocker").count()).toBe(0);
        await submit.click();
        await expect.poll(() => fake.publishes).toEqual([{ revision: 6, confirmDiff: true }]);

        // The end: the published version, the site and the owner's cabinet, nothing more to publish.
        await page.getByTestId("canvas-v3-publish-result").waitFor({ timeout: 15_000 });
        await page.getByTestId("canvas-v3-publish-prod").waitFor();
        expect(await page.getByTestId("canvas-v3-publish-prod").textContent()).toBe("Опубликована версия 6");
        expect(await page.getByTestId("canvas-v3-publish-site").getAttribute("href")).toBe(PROD);
        expect(await page.getByTestId("canvas-v3-publish-cabinet").getAttribute("href")).toBe(
          `${PROD}login?next=%2Fcabinet`,
        );
        await page.getByTestId("canvas-v3-publish-uptodate").waitFor();
        expect(await submit.count()).toBe(0);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-publish-${tag}-2-published.png`) });

        // The settings link of the card leads to the system's settings.
        await page.getByTestId("canvas-v3-publish-settings").click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/${fake.systemId}/settings`);
        await page.context().close();
      }, 90_000);
});
