// V4-04 acceptance 1, the browser part: the report's screenshots of the built site at 390 (the first screen) and 1440
// (the whole page) through the critic's inspector, and the HTTP responses of a scenario's steps — every context the
// scenario check opens records its documents and API answers (a failed one with its body), attributed to the scenario.
import { createServer, type Server } from "node:http";
import { createPageComposer } from "@wizard/agents/builder";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { afterAll, describe, expect, test } from "vitest";
import { composeContext } from "../../../packages/agents/test/v3-compose-fixtures.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";
import { httpRecorder } from "../src/builds-v3/report/http.js";
import { siteShots } from "../src/builds-v3/report/shots.js";
import type { BuildStore } from "../src/runs/types.js";

const browser = chromiumProvider({ slots: 1 });
let server: Server | null = null;

afterAll(async () => {
  await browser.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/** The fixture clinic after the skeleton as a build store (read side only). */
async function clinicStore(): Promise<BuildStore> {
  const base = composeContext();
  const out = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
  const files = new Map(base.files);
  for (const [p, v] of out.files) {
    if (v === null) files.delete(p);
    else files.set(p, v);
  }
  return {
    getSpec: async () => ({ spec: base.spec, version: 1 }),
    listFiles: async () => [...files.keys()],
    readFile: async (p: string) => files.get(p) ?? null,
  } as unknown as BuildStore;
}

describe("V4-04: screenshots and HTTP responses of the report", () => {
  test("the home page at 390 and 1440 (JPEG)", async () => {
    const r = await siteShots(await clinicStore(), browser);
    expect(r.error).toBeUndefined();
    expect(r.shots.map((s) => s.width).sort((a, b) => a - b)).toEqual([390, 1440]);
    for (const s of r.shots) {
      expect(s.mime).toBe("image/jpeg");
      expect(s.data.byteLength).toBeGreaterThan(1_000);
      expect([...s.data.slice(0, 2)]).toEqual([0xff, 0xd8]);
    }
  }, 120_000);

  test("a scenario's documents and API answers, a failed one with its body; nothing outside a scenario", async () => {
    server = createServer((req, res) => {
      if (req.url === "/api/lead") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Телефон owner@clinic.ru +7 900 123-45-67 не прошёл проверку" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>t</title><script>fetch("/api/lead",{method:"POST",body:"{}"})</script>`);
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const rec = httpRecorder();
    const provider = rec.provider(browser);
    const visit = async () => {
      const lease = await provider?.acquire();
      if (!lease) throw new Error("no browser");
      const ctx = await lease.browser.newContext();
      const page = await ctx.newPage();
      const answered = page.waitForResponse((r) => r.url().endsWith("/api/lead"));
      await page.goto(`http://localhost:${port}/`);
      await answered;
      await page.waitForTimeout(200);
      await ctx.close();
      lease.release();
    };
    await rec.scenario("s_lead", visit);
    await visit();
    const http = rec.responses();
    expect(http.map((h) => `${h.scenario} ${h.method} ${h.url} ${h.status} ${h.type}`)).toEqual([
      "s_lead GET / 200 document",
      "s_lead POST /api/lead 422 fetch",
    ]);
    const failed = http.find((h) => h.status === 422);
    expect(failed?.body).toContain("не прошёл проверку");
    expect(failed?.body).not.toContain("owner@clinic.ru");
    expect(failed?.body).not.toContain("123-45-67");
  }, 60_000);
});
