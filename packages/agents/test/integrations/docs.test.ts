// V3-20 acceptance 1 (documentation side): a documentation link → discover_docs finds openapi.json → contract by code
// with the field mapping, no model; prose documentation → one research call (T0) whose draft code checks against the
// page (invented hosts are refused and repaired); without a model route prose gives a Russian reason. Research runs
// over a fake documentation site (fixture mode, no network).
import { describe, expect, test } from "vitest";
import {
  contractFromDocs,
  contractFromProse,
  mockTransport,
  PROSE_CALL_TYPE,
  runContractTests,
} from "../../src/integrations/index.js";
import { createResearch, MemoryResearchStore } from "../../src/research/index.js";
import { scriptedRoute, toolResult } from "../helpers.js";
import { crmSiteFetch, DELIVERY_DOC } from "./fixtures.js";

const research = () =>
  createResearch({ env: {}, mode: "fixture", fetch: crmSiteFetch(), store: new MemoryResearchStore() });

const draft = (host = "api.bystraya-posylka.ru") => ({
  baseUrl: `https://${host}/v1`,
  auth: { kind: "header", name: "X-Token" },
  operations: [
    {
      id: "createOrder",
      method: "POST",
      path: "/orders",
      summary: "Создать заказ на доставку",
      params: [],
      body: [
        { name: "recipient_name", type: "string", required: true },
        { name: "recipient_phone", type: "string", required: false },
        { name: "address", type: "string", required: true },
      ],
      response: [
        { name: "id", type: "integer" },
        { name: "status", type: "string" },
      ],
    },
    {
      id: "getOrder",
      method: "GET",
      path: "/orders/{id}",
      summary: "Статус заказа",
      params: [{ name: "id", in: "path", type: "integer", required: true }],
      body: null,
      response: [
        { name: "id", type: "integer" },
        { name: "status", type: "string" },
      ],
    },
    {
      id: "listTariffs",
      method: "GET",
      path: "/tariffs",
      summary: "Тарифы",
      params: [],
      body: null,
      response: [{ name: "items", type: "string" }],
    },
  ],
  mapping: [
    {
      entity: "Заказ",
      field: "Телефон",
      operation: "createOrder",
      apiField: "recipient_phone",
      direction: "to_api",
    },
  ],
});

describe("documentation → contract", () => {
  test("discover_docs finds openapi.json: the contract is made by code with the mapping, no model call", async () => {
    const { route, inputs } = scriptedRoute([]);
    const r = await contractFromDocs({
      research: research(),
      id: "crm",
      name: "Partner CRM",
      url: "https://partner-crm.ru/docs",
      need: "заявки с сайта в CRM",
      data: [{ entity: "Заявка", fields: [{ name: "Имя" }, { name: "Телефон" }] }],
      route,
    });
    expect(r.method).toBe("openapi");
    expect(inputs).toHaveLength(0);
    expect(r.contract?.source.url).toBe("https://partner-crm.ru/openapi.json");
    expect(r.contract?.mapping.some((m) => m.field === "Телефон" && m.pointer === "/body/phone")).toBe(true);
    const c = r.contract;
    if (!c) throw new Error("no contract");
    expect((await runContractTests(c, mockTransport(c))).ok).toBe(true);
  });

  test("prose documentation: one T0 research call; the draft is checked against the page and becomes a contract", async () => {
    const { route, inputs } = scriptedRoute([toolResult("submit_contract_draft", draft())]);
    const r = await contractFromDocs({
      research: createResearch({
        env: {},
        mode: "fixture",
        fetch: crmSiteFetch(),
        store: new MemoryResearchStore(),
      }),
      id: "delivery",
      name: "Быстрая посылка",
      url: "https://bystraya-posylka.ru/docs",
      need: "создавать заказы на доставку",
      route,
    });
    expect(r.method).toBe("prose");
    expect(inputs.map((i) => i.callType)).toEqual([PROSE_CALL_TYPE]);
    const c = r.contract;
    if (!c) throw new Error(r.reason_ru ?? "no contract");
    expect(c.source.kind).toBe("prose");
    expect(c.hosts).toEqual(["api.bystraya-posylka.ru"]);
    expect(c.auth).toEqual({ kind: "header", name: "X-Token", secret: "secret://delivery_key" });
    // the safe GET without parameters checks the key (getOrder needs an id)
    expect(c.check).toEqual({ operation: "listTariffs" });
    expect(c.mapping).toEqual([
      {
        entity: "Заказ",
        field: "Телефон",
        operation: "createOrder",
        pointer: "/body/recipient_phone",
        direction: "to_api",
        by: "model",
      },
    ]);
    expect((await runContractTests(c, mockTransport(c))).ok).toBe(true);
  });

  test("an invented host is refused and repaired; a model that keeps inventing gives no contract", async () => {
    const repaired = scriptedRoute([
      toolResult("submit_contract_draft", draft("api.evil-mirror.ru")),
      toolResult("submit_contract_draft", draft()),
    ]);
    const ok = await contractFromProse({
      id: "delivery",
      name: "Быстрая посылка",
      need: "заказы",
      markdown: DELIVERY_DOC,
      url: "https://bystraya-posylka.ru/docs",
      route: repaired.route,
    });
    expect(ok.contract?.hosts).toEqual(["api.bystraya-posylka.ru"]);
    expect(JSON.stringify(repaired.inputs[1]?.messages)).toMatch(/does not appear in the documentation/);

    const stubborn = scriptedRoute(
      Array(3).fill(toolResult("submit_contract_draft", draft("api.evil-mirror.ru"))),
    );
    const bad = await contractFromProse({
      id: "delivery",
      name: "Быстрая посылка",
      need: "заказы",
      markdown: DELIVERY_DOC,
      url: "https://bystraya-posylka.ru/docs",
      route: stubborn.route,
    });
    expect(bad.contract).toBeNull();
    expect(bad.reason_ru).toMatch(/хосты или адреса/);
  });

  test("prose without a model route: no contract and a Russian reason", async () => {
    const r = await contractFromDocs({
      research: research(),
      id: "delivery",
      name: "Быстрая посылка",
      url: "https://bystraya-posylka.ru/docs",
    });
    expect(r.contract).toBeNull();
    expect(r.reason_ru).toMatch(/OpenAPI/);
  });
});
