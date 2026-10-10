// V3-40: the payment check of shops already built (tools/eval/server/pay-probe.mjs) — the system ids it takes, the
// session it asks the database for (one eval org only), the purchase per system, the report and the final report's
// payment replaced by the check's with the readiness judged again.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyPayProbe,
  parsePayProbeSeed,
  parsePaySystems,
  payProbeAnnotations,
  payProbeSessionSql,
  renderPayProbeReport,
  runPayProbe,
  saveRepoArchive,
} from "../server/pay-probe.mjs";

const A = "cd76a3c8-b8d0-4fa7-95de-c61108e9e11f";
const B = "0c07ecad-db25-4a53-8a25-1cad47f688c8";
const C = "4d6552eb-8ee7-45be-926a-4375881a0d04";
const HASH = "a".repeat(64);

describe("pay probe", () => {
  test("system ids: up to three distinct uuids; anything else refused in Russian", () => {
    expect(parsePaySystems(` ${A}, ${B.toUpperCase()}`)).toEqual([A, B]);
    expect(() => parsePaySystems("")).toThrow(/id систем/);
    expect(() => parsePaySystems(`${A},${B},${C},${A.replace("c", "d")}`)).toThrow(/не больше 3/);
    expect(() => parsePaySystems(`${A},${A}`)).toThrow(/дважды/);
    expect(() => parsePaySystems(`${A};drop table`)).toThrow(/не id системы/);
  });

  test("the session SQL: only systems of one eval org, the owner's session by hashes, values as psql variables", () => {
    const sql = payProbeSessionSql({ systemIds: [A, B], tokenHash: HASH, csrfHash: HASH });
    expect(sql).toContain(`\\set systems '{${A},${B}}'`);
    expect(sql).toContain("\\set n '2'");
    expect(sql).toContain("o.kind = 'eval'");
    expect(sql).toContain("HAVING count(DISTINCT sys.org_id) = 1 AND count(*) = :'n'::int");
    expect(sql).toContain("m.role = 'owner'");
    expect(sql).toContain("INSERT INTO platform.sessions (user_id, token_hash, csrf_hash, expires_at)");
    expect(() => payProbeSessionSql({ systemIds: [A], tokenHash: "raw-token", csrfHash: HASH })).toThrow(/sha256/);
    expect(() => payProbeSessionSql({ systemIds: [A], tokenHash: HASH, csrfHash: HASH, hours: 48 })).toThrow(
      /1…6 часов/,
    );
    const ids = {
      userId: "22222222-2222-4222-8222-222222222222",
      orgId: "11111111-1111-4111-8111-111111111111",
      sessionId: "33333333-3333-4333-8333-333333333333",
    };
    expect(parsePayProbeSeed(`\n${JSON.stringify(ids)}\n`)).toEqual(ids);
    expect(() => parsePayProbeSeed("")).toThrow(/не из одной учётки замера/);
  });

  test("each system in turn, a throwing purchase is the system's failure; report, annotations", async () => {
    const client = {
      get: async (path: string) => ({ status: 200, body: { name: path.endsWith(A) ? "Керамика" : "Чай Алтая" } }),
    };
    const results = await runPayProbe({
      client,
      systemIds: [A, B],
      pay: async (_c: unknown, id: string) => {
        if (id === B) throw new Error("browser closed");
        return {
          status: "paid",
          orderStatus: "Оплачен",
          steps: [
            { step: "выбран способ оплаты «Новая карта»", ok: true },
            { step: "статус заказа «Оплачен»", ok: true },
          ],
        };
      },
    });
    expect(results.map((r) => [r.name, r.payment.status])).toEqual([
      ["Керамика", "paid"],
      ["Чай Алтая", "failed"],
    ]);
    const { text, summary } = renderPayProbeReport(results, { date: "2026-10-10", runid: "20261010-abcdef" });
    expect(summary).toEqual({ paid: 1, total: 2, passed: false });
    expect(text).toContain("**Оплачено: 1 из 2.**");
    expect(text).toContain("- Статус заказа: «Оплачен»");
    expect(text).toContain("  - ❌ сбой проверки — browser closed");
    expect(payProbeAnnotations(results)).toEqual([
      "::notice title=Оплата · Керамика::оплачено тестовой картой, статус заказа «Оплачен»",
      "::error title=Оплата · Чай Алтая::сбой проверки — browser closed",
    ]);
  });

  test("the final report: the check's payment on the same system, readiness judged again; others unchanged", () => {
    const shop = (id: string, systemId: string, status = "not_ready") => ({
      id,
      systemId,
      status,
      ready: false,
      build: { status: "succeeded", scenarios: { mustNotPassed: 0 } },
      gates: { G0: { passed: true }, G1: { passed: true }, G2: { passed: true } },
      techreview: { blocked: false },
      publish: { status: "review_pending" },
      payment: { status: "failed", steps: [{ step: "поле номера карты", ok: false }] },
    });
    const out = applyPayProbe(
      [shop("v3-05", A), shop("v3-11", B), shop("v3-12", C, "build_failed")],
      [
        { systemId: A, payment: { status: "paid", orderStatus: "Оплачен", steps: [] } },
        { systemId: B, payment: { status: "failed", steps: [] } },
        { systemId: C, payment: { status: "paid", steps: [] } },
      ],
      { runid: "20261010-abcdef" },
    );
    expect(out[0]).toMatchObject({
      status: "ready",
      ready: true,
      payment: { status: "paid", recheck: "20261010-abcdef", before: "failed" },
    });
    expect(out[1]).toMatchObject({ status: "not_ready", ready: false, payment: { status: "failed" } });
    // A system that never got built stays as the measurement left it.
    expect(out[2]).toMatchObject({ status: "build_failed", ready: false, payment: { status: "paid" } });
  });

  test("a system without online payment is not counted; its code archive is saved byte for byte", async () => {
    const results = [
      { systemId: A, name: "Керамика", payment: { status: "paid", orderStatus: "Оплачен", steps: [] } },
      { systemId: B, name: "Обжарка", payment: { status: "skipped", note: "в системе нет онлайн-оплаты" } },
    ];
    expect(renderPayProbeReport(results, {}).summary).toEqual({ paid: 1, total: 1, passed: true });
    expect(payProbeAnnotations(results)[1]).toBe(
      "::notice title=Оплата · Обжарка::в системе нет онлайн-оплаты — сохранён архив кода",
    );
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    const seen: { url: string; cookie: string }[] = [];
    const file = join(mkdtempSync(join(tmpdir(), "wz-repo-")), "repo", `${B}.zip`);
    const a = await saveRepoArchive({
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        seen.push({ url, cookie: init.headers.cookie });
        return new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
      }) as unknown as typeof fetch,
      base: "https://borntobuild.ru",
      session: { token: "t0", csrf: "c0" },
      systemId: B,
      file,
    });
    expect(a).toEqual({ saved: zip.length });
    expect([...readFileSync(file)]).toEqual([...zip]);
    expect(seen).toEqual([
      {
        url: `https://borntobuild.ru/api/v1/systems/${B}/repo/archive`,
        cookie: "__Host-wizard_session=t0; __Host-wizard_csrf=c0",
      },
    ]);
    const denied = await saveRepoArchive({
      fetch: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
      base: "https://borntobuild.ru",
      session: { token: "t0", csrf: "c0" },
      systemId: B,
      file,
    });
    expect(denied).toEqual({ saved: 0, why: "HTTP 404" });
  });
});
