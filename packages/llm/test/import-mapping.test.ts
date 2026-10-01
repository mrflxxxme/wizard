// import_mapping over a SyntheticPayload (data-boundary.yaml#import.test, #routing.constraints): a mock T1 records
// every request; no canary value of the imported table ever appears in one.
import { buildMappingPayload, readTable, writeXlsx } from "@wizard/pii/import";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { canaryGrid, canaryNeedles, canaryRows } from "../../pii/test/import-canaries.js";
import {
  createRouter,
  IMPORT_MAPPING_TOOL,
  type ImportEntityRef,
  LlmError,
  MemoryUsageSink,
  routeImportMapping,
} from "../src/index.js";
import { type Responder, type Stub, startStub } from "./stub-server.js";

let stub: Stub;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());

const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = {
  orgId: "00000000-0000-4000-8000-0000000000b1",
  systemId: "00000000-0000-4000-8000-0000000000b2",
};
const ENTITIES: ImportEntityRef[] = [
  {
    name: "client",
    label: "Клиент",
    fields: [
      { name: "full_name", type: "string" },
      { name: "phone", type: "phone" },
      { name: "email", type: "email" },
      { name: "city", type: "string" },
      { name: "total", type: "money" },
    ],
  },
];

const proposeMapping: Responder = (req) => ({
  status: 200,
  body: {
    id: "c",
    object: "chat.completion",
    created: 1,
    model: String(req.body.model),
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "propose_mapping",
                arguments: JSON.stringify({
                  mappings: [
                    {
                      sheet: "Клиенты",
                      column: "ФИО клиента",
                      action: "map",
                      entity: "client",
                      field: "full_name",
                    },
                    { sheet: "Клиенты", column: "Телефон", action: "map", entity: "client", field: "phone" },
                    { sheet: "Клиенты", column: "Почта", action: "map", entity: "client", field: "email" },
                    {
                      sheet: "Клиенты",
                      column: "Город",
                      action: "map",
                      entity: "client",
                      field: "city",
                      pii: "none",
                    },
                    {
                      sheet: "Клиенты",
                      column: "Сумма заказа",
                      action: "map",
                      entity: "client",
                      field: "nope",
                    },
                    {
                      sheet: "Клиенты",
                      column: "Комментарий",
                      action: "new_field",
                      entity: "client",
                      field: "note",
                    },
                    { sheet: "Клиенты", column: "Лишняя", action: "map", entity: "client", field: "city" },
                  ],
                }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
  },
});

beforeEach(() => {
  stub.requests.length = 0;
  stub.respond.zai = proposeMapping;
  stub.respond.cloudru = proposeMapping;
});

const rows = canaryRows(50);
const table = readTable(writeXlsx([{ name: "Клиенты", rows: canaryGrid(rows) }]), {
  filename: "clients.xlsx",
});
const needles = canaryNeedles(rows);

function router() {
  const sink = new MemoryUsageSink();
  return { sink, router: createRouter({ mode: "live", env: stub.env(), sink, sleep: async () => {} }) };
}

describe("routeImportMapping", () => {
  test("goes to T1 with the synthetic payload only; no canary in any T1 request", async () => {
    const { router: r, sink } = router();
    for (let seed = 1; seed <= 5; seed++) {
      const out = await routeImportMapping(r, {
        payload: buildMappingPayload(table, { seed }),
        entities: ENTITIES,
        orgPolicy: OPEN,
        ctx,
      });
      expect(out.tier).toBe("T1");
      expect(out.routeReason).toBe("default_T1");
    }
    const t1 = stub.requests.filter((q) => q.provider === "zai");
    expect(t1).toHaveLength(5);
    expect(stub.requests).toHaveLength(5);
    for (const q of t1) for (const n of needles) expect(q.raw, n).not.toContain(n);
    const body = t1[0]?.body as { tools?: Array<{ function: { name: string } }>; tool_choice?: unknown };
    expect(body.tools?.map((t) => t.function.name)).toEqual([IMPORT_MAPPING_TOOL.name]);
    expect(sink.records.every((x) => x.callType === "import_mapping" && x.tier === "T1" && x.scrubbed)).toBe(
      true,
    );
    expect(sink.records.every((x) => Object.keys(x.piiCategoriesCount).length === 0)).toBe(true);
  });

  test("the proposal is normalized to one item per column; unknown fields are skipped; PII flags kept", async () => {
    const { router: r } = router();
    const out = await routeImportMapping(r, {
      payload: buildMappingPayload(table, { seed: 1 }),
      entities: ENTITIES,
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.mapping).toEqual([
      {
        sheet: "Клиенты",
        column: "ФИО клиента",
        action: "map",
        entity: "client",
        field: "full_name",
        pii: "basic",
      },
      { sheet: "Клиенты", column: "Телефон", action: "map", entity: "client", field: "phone", pii: "basic" },
      { sheet: "Клиенты", column: "Почта", action: "map", entity: "client", field: "email", pii: "basic" },
      { sheet: "Клиенты", column: "Город", action: "map", entity: "client", field: "city", pii: "none" },
      { sheet: "Клиенты", column: "Сумма заказа", action: "skip", pii: "none" },
      {
        sheet: "Клиенты",
        column: "Комментарий",
        action: "new_field",
        entity: "client",
        field: "note",
        pii: "basic",
      },
    ]);
  });

  test("anything but a SyntheticPayload is refused before routing", async () => {
    const { router: r } = router();
    const fake = structuredClone(buildMappingPayload(table, { seed: 1 }));
    await expect(routeImportMapping(r, { payload: fake, orgPolicy: OPEN, ctx })).rejects.toMatchObject({
      code: "IMPORT_PAYLOAD_NOT_SYNTHETIC",
    });
    await expect(
      routeImportMapping(r, { payload: { sheets: table.sheets } as never, orgPolicy: OPEN, ctx }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(stub.requests).toHaveLength(0);
  });

  test("ruOnly or an unknown region → T0 even for a synthetic payload", async () => {
    const { router: r } = router();
    const payload = buildMappingPayload(table, { seed: 2 });
    expect(
      (await routeImportMapping(r, { payload, orgPolicy: { ruOnly: true, t1Restricted: false }, ctx })).tier,
    ).toBe("T0");
    expect((await routeImportMapping(r, { payload, orgPolicy: { ruOnly: false }, ctx })).tier).toBe("T0");
    expect(stub.requests.every((q) => q.provider === "cloudru")).toBe(true);
  });

  test("real values in an import_mapping call never reach T1, even with containsPiiHint=false", async () => {
    const { router: r } = router();
    const out = await r.route({
      callType: "import_mapping",
      messages: [{ role: "user", content: JSON.stringify(table.sheets[0]?.rows.slice(0, 3)) }],
      tools: [IMPORT_MAPPING_TOOL],
      containsPiiHint: false,
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.tier).toBe("T0");
    expect(out.routeReason).toBe("callType_forbidden_T1");
    expect(stub.requests.some((q) => q.provider === "zai")).toBe(false);
  });
});
