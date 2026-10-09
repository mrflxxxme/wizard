// V3-20 acceptance 1 (agent side): documentation → contract (subset of OpenAPI 3.1, field mapping, allowed hosts,
// secret://) by code, the deterministic mock and the contract tests, the key check classification, the contract
// reference of the brief. No network, no model.
import { describe, expect, test } from "vitest";
import {
  buildRequest,
  CONTRACT_FORMAT,
  checkContractKey,
  contractFromOpenApi,
  contractHash,
  contractRef,
  type IntegrationContract,
  type IntegrationTransport,
  mapFields,
  mockTransport,
  needWords,
  OpenApiImportError,
  parseContract,
  parseContractRef,
  runContractTests,
  sampleValue,
  validateValue,
} from "../../src/integrations/index.js";
import { CRM_HOST, crmOpenApi, crmSwagger } from "./fixtures.js";

const crm = (need = "Заявки с сайта уходят в CRM как сделки") =>
  contractFromOpenApi(crmOpenApi(), {
    id: "crm",
    name: "Partner CRM",
    need,
    url: "https://partner-crm.ru/openapi.json",
  });

describe("OpenAPI → contract by code", () => {
  test("a 22-operation document is narrowed to the lead operations of the need, plus a safe GET for the key check", () => {
    const c = crm();
    expect(c.format).toBe(CONTRACT_FORMAT);
    expect(c.baseUrl).toBe(`https://${CRM_HOST}/v2`);
    expect(c.hosts).toEqual([CRM_HOST]);
    expect(c.auth).toEqual({ kind: "header", name: "X-Api-Key", secret: "secret://crm_key" });
    const ids = c.operations.map((o) => o.id);
    expect(ids).toEqual(
      expect.arrayContaining(["listLeads", "createLead", "getLead", "updateLead", "deleteLead"]),
    );
    expect(ids).not.toContain("listWebhooks");
    // multipart upload is not a JSON operation: left out
    expect(ids).not.toContain("uploadAttachment");
    expect(c.check).not.toBeNull();
    const check = c.operations.find((o) => o.id === c.check?.operation);
    expect(check?.method).toBe("GET");
    expect(check?.params.some((p) => p.required)).toBe(false);
    expect(c.notes.join(" ")).toMatch(/выбрано/);
  });

  test("$ref, allOf, nullable type arrays, enums and path parameters are resolved into the subset", () => {
    const c = crm();
    const create = c.operations.find((o) => o.id === "createLead");
    expect(create?.body?.required).toBe(true);
    expect(create?.body?.schema.required).toEqual(["name"]);
    expect(create?.body?.schema.properties?.phone).toMatchObject({ type: "string", nullable: true });
    expect(create?.body?.schema.properties?.status?.enum).toEqual(["new", "in_work", "won", "lost"]);
    expect(create?.response.status).toBe(201);
    // allOf: LeadBase + {id, created_at}
    expect(Object.keys(create?.response.schema.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "name", "created_at"]),
    );
    expect(create?.response.schema.required).toEqual(expect.arrayContaining(["id", "name"]));
    const get = c.operations.find((o) => o.id === "getLead");
    expect(get?.params).toEqual([
      { name: "leadId", in: "path", required: true, schema: { type: "integer" }, arg: "leadId" },
    ]);
    expect(c.operations.find((o) => o.id === "deleteLead")?.response.status).toBe(204);
  });

  test("Swagger 2.0: host/basePath, body parameter, query key", () => {
    const c = contractFromOpenApi(crmSwagger(), { id: "crm", name: "CRM" });
    expect(c.source.kind).toBe("swagger");
    expect(c.baseUrl).toBe(`https://${CRM_HOST}/v1`);
    expect(c.auth).toEqual({ kind: "query", name: "token", secret: "secret://crm_key" });
    const req = buildRequest(c, "listLeads", {});
    // the key reference stays unencoded in the query: the runtime substitutes it there
    expect(req.url).toBe(`https://${CRM_HOST}/v1/leads?token=secret://crm_key`);
  });

  test("documents without https servers or operations are refused with a Russian reason", () => {
    const doc = { ...crmOpenApi(), servers: [{ url: "http://api.partner-crm.ru" }] };
    expect(() => contractFromOpenApi(doc, { id: "crm", name: "CRM" })).toThrow(OpenApiImportError);
    expect(() => contractFromOpenApi('{"hello":1}', { id: "crm", name: "CRM" })).toThrow(/OpenAPI/);
  });

  test("need words: Russian stems expand to the English words of API paths", () => {
    expect(needWords("Заявки и сделки в CRM")).toEqual(expect.arrayContaining(["lead", "deal"]));
    expect(needWords("доставка заказов")).toEqual(expect.arrayContaining(["order", "deliver"]));
  });
});

describe("contract schema and reference", () => {
  test("hosts must cover the base URL; check must be a GET; the key only as secret://", () => {
    const c = crm();
    expect(() => parseContract({ ...c, hosts: ["evil.example.ru"] })).toThrow(/базового адреса/);
    expect(() => parseContract({ ...c, auth: { ...c.auth, secret: "sk_live_123" } })).toThrow();
    const post = c.operations.find((o) => o.method === "POST")?.id as string;
    expect(() => parseContract({ ...c, check: { operation: post } })).toThrow(/GET/);
  });

  test("contractRef: contract://<id>@<version>#<sha12> round trip; other references are not contracts", () => {
    const c = crm();
    const sha = contractHash(c);
    expect(contractHash(crm())).toBe(sha);
    const ref = contractRef("crm", 3, sha);
    expect(ref).toBe(`contract://crm@3#${sha.slice(0, 12)}`);
    expect(parseContractRef(ref)).toEqual({ id: "crm", version: 3, sha12: sha.slice(0, 12) });
    expect(parseContractRef("https://partner-crm.ru/docs")).toBeNull();
  });

  test("field mapping by names and synonyms: brief data in Russian → request and answer fields", () => {
    const c = crm();
    const m = mapFields(c, [
      {
        entity: "Заявка",
        fields: [{ name: "Имя" }, { name: "Телефон" }, { name: "Комментарий" }, { name: "Почта" }],
      },
    ]);
    const create = m
      .filter((x) => x.operation === "createLead" && x.direction === "to_api")
      .map((x) => `${x.field}→${x.pointer}`);
    expect(create).toEqual(
      expect.arrayContaining([
        "Имя→/body/name",
        "Телефон→/body/phone",
        "Комментарий→/body/comment",
        "Почта→/body/email",
      ]),
    );
    expect(m.some((x) => x.direction === "from_api" && x.pointer === "/response/phone")).toBe(true);
    expect(() => parseContract({ ...c, mapping: m })).not.toThrow();
  });
});

describe("deterministic mock and contract tests", () => {
  test("the same contract gives the same answers; every operation passes its contract test on the mock", async () => {
    const c = crm();
    const a = await runContractTests(c, mockTransport(c));
    expect(a.ok).toBe(true);
    expect(a.passed).toBe(c.operations.length);
    const req = buildRequest(c, "createLead", { body: { name: "Иван" } });
    const r1 = await mockTransport(c)(req);
    const r2 = await mockTransport(crm())(req);
    expect(r1).toEqual(r2);
    expect(r1.status).toBe(201);
    expect(
      validateValue(
        c.operations.find((o) => o.id === "createLead")?.response.schema ?? {},
        JSON.parse(r1.text),
      ),
    ).toEqual([]);
  });

  test("the mock refuses requests without the key and bodies that break the schema", async () => {
    const c = crm();
    const mock = mockTransport(c);
    const noKey = buildRequest(c, "createLead", { body: { name: "Иван" } });
    delete noKey.headers["X-Api-Key"];
    expect((await mock(noKey)).status).toBe(401);
    const bad = await mock(buildRequest(c, "createLead", { body: { phone: 5 } }));
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/name/);
    expect(
      (await mock({ ...buildRequest(c, "listLeads", {}), url: `https://${CRM_HOST}/v2/unknown` })).status,
    ).toBe(404);
  });

  test("contract tests catch an API that drifted from the contract", async () => {
    const c = crm();
    const mock = mockTransport(c);
    const drifted: IntegrationTransport = async (req) => {
      const r = await mock(req);
      if (req.method === "GET" && /\/leads(\?|$)/.test(req.url))
        return { ...r, text: JSON.stringify({ items: "x" }) };
      return r;
    };
    const report = await runContractTests(c, drifted);
    expect(report.ok).toBe(false);
    const bad = report.results.find((r) => !r.ok);
    expect(bad?.operation).toBe("listLeads");
    expect(bad?.problems.join(" ")).toMatch(/total|список/);
  });

  test("samples are valid for their schema and stable per seed", () => {
    const schema = crm().operations.find((o) => o.id === "listLeads")?.response.schema ?? {};
    const v1 = sampleValue(schema, "s");
    expect(validateValue(schema, v1)).toEqual([]);
    expect(sampleValue(schema, "s")).toEqual(v1);
  });
});

describe("key check", () => {
  const api = (c: IntegrationContract, status: number, body?: unknown): IntegrationTransport => {
    const mock = mockTransport(c);
    return async (req) =>
      status === 200
        ? mock(req)
        : { status, contentType: "application/json", text: JSON.stringify(body ?? {}) };
  };

  test("2xx matching the contract → OK and verified; the request carries only secret://", async () => {
    const c = crm();
    const seen: string[] = [];
    const mock = mockTransport(c);
    const r = await checkContractKey(c, async (req) => {
      seen.push(JSON.stringify(req));
      return mock(req);
    });
    expect(r).toMatchObject({ ok: true, verified: true, code: "OK" });
    expect(seen.join("")).toContain("secret://crm_key");
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] as string).method).toBe("GET");
  });

  test("401 → AUTH_FAILED, 5xx → UPSTREAM_UNAVAILABLE, a refused host → EGRESS_FORBIDDEN, drift → CONTRACT_MISMATCH", async () => {
    const c = crm();
    expect(await checkContractKey(c, api(c, 401))).toMatchObject({ ok: false, code: "AUTH_FAILED" });
    expect(await checkContractKey(c, api(c, 503))).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE" });
    const refused = await checkContractKey(c, async () => {
      throw Object.assign(new Error("x"), {
        code: "EGRESS_FORBIDDEN",
        details: { message: "Хост не разрешён" },
      });
    });
    expect(refused).toMatchObject({ ok: false, code: "EGRESS_FORBIDDEN" });
    const drift = await checkContractKey(c, async () => ({
      status: 200,
      contentType: "application/json",
      text: "[]",
    }));
    expect(drift).toMatchObject({ ok: false, code: "CONTRACT_MISMATCH" });
  });

  test("no safe GET → the check sends nothing and switches on unverified", async () => {
    const c = { ...crm(), check: null };
    let sent = 0;
    const r = await checkContractKey(c, async () => {
      sent++;
      return { status: 200, contentType: null, text: "" };
    });
    expect(r).toMatchObject({ ok: true, verified: false, code: "NO_CHECK_OPERATION" });
    expect(sent).toBe(0);
  });
});
