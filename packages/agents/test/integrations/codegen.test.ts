// V3-20 acceptance 1–2 (code side): the typed client of a contract as system code in functions/integrations/<id>/**,
// checked by G0 (imports, forbidden APIs, v.* arguments, strict tsc) in both modes; mock mode has no network code,
// no egress and no key; live mode declares exactly the contract's hosts and key (D37). The build layer: notes for
// integrations without a contract and incoming ones, the merge into the backend, refusal of a widened egress.
import { type AppSpec, emptySpec, systemBriefSchema } from "@wizard/appspec";
import { checkCode } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import {
  contractFromOpenApi,
  contractHash,
  integrationCode,
  integrationEgressIssues,
  integrationFunctionName,
  integrationLayer,
  withIntegrationLayer,
} from "../../src/integrations/index.js";
import { CRM_HOST, crmOpenApi, crmSwagger } from "./fixtures.js";

const crm = () => contractFromOpenApi(crmOpenApi(), { id: "crm", name: "Partner CRM", need: "заявки в CRM" });
const REF = "contract://crm@1#000000000000";
/** The smallest valid system: one admin role. */
const baseSpec = (): AppSpec =>
  ({
    ...emptySpec("CRM"),
    roles: [{ name: "owner", label: "Владелец", access: "login", isAdmin: true }],
  }) as AppSpec;

function systemOf(code: ReturnType<typeof integrationCode>): { spec: AppSpec; files: Map<string, string> } {
  const spec = { ...baseSpec(), functions: code.functions } as AppSpec;
  return { spec, files: new Map(Object.entries(code.files)) };
}

describe("generated client", () => {
  test("mock mode: G0 passes; no ctx.http, no egress, no key; answers are the contract's mock bodies", async () => {
    const c = crm();
    const code = integrationCode(c, "mock", REF);
    expect(Object.keys(code.files).every((p) => p.startsWith("functions/integrations/crm/"))).toBe(true);
    expect(code.functions.map((f) => f.name)).toContain(integrationFunctionName("crm", "createLead"));
    expect(integrationFunctionName("crm", "createLead")).toBe("crmCreateLead");
    for (const f of code.functions) {
      expect(f.kind).toBe("action");
      expect(f.egress).toBeUndefined();
      expect(f.secretRefs).toBeUndefined();
    }
    const all = Object.values(code.files).join("\n");
    expect(all).not.toMatch(/http\.fetch/);
    expect(all).not.toMatch(/secret:\/\//);
    const { spec, files } = systemOf(code);
    expect(await checkCode({ spec, files })).toEqual([]);
  }, 60_000);

  test("live mode: G0 passes; literal https URLs of the contract, the key only as secret://, egress = contract hosts", async () => {
    const c = crm();
    const code = integrationCode(c, "live", REF);
    for (const f of code.functions) {
      expect(f.egress).toEqual([CRM_HOST]);
      expect(f.secretRefs).toEqual(["secret://crm_key"]);
    }
    const client = code.files["functions/integrations/crm/client.ts"] as string;
    expect(client).toContain(`ctx.http.fetch(\`https://${CRM_HOST}/v2/leads/\${seg(input.leadId)}`);
    expect(client).toContain(`"X-Api-Key": "secret://crm_key"`);
    expect(code.files["functions/integrations/crm/createLead.ts"]).toMatch(
      /args: \{\n\s+body: v\.object\(\{/,
    );
    const { spec, files } = systemOf(code);
    expect(await checkCode({ spec, files })).toEqual([]);
    expect(integrationEgressIssues(spec, [c])).toEqual([]);
  }, 60_000);

  test("query key (Swagger): the reference is appended unencoded; G0 passes", async () => {
    const c = contractFromOpenApi(crmSwagger(), { id: "crm", name: "CRM" });
    const code = integrationCode(c, "live", REF);
    expect(code.files["functions/integrations/crm/client.ts"]).toContain(`"token=secret://crm_key"`);
    const { spec, files } = systemOf(code);
    expect(await checkCode({ spec, files })).toEqual([]);
  }, 60_000);
});

describe("D37: integration egress ⊆ contract hosts", () => {
  test("a widened host, a foreign key or an integration function without a contract is an issue", () => {
    const c = crm();
    const code = integrationCode(c, "live", REF);
    const spec = { ...emptySpec("CRM"), functions: code.functions } as AppSpec;
    const fns = spec.functions ?? [];
    const widened = {
      ...spec,
      functions: [
        { ...(fns[0] as (typeof fns)[number]), egress: [CRM_HOST, "evil.example.ru"] },
        { ...(fns[1] as (typeof fns)[number]), secretRefs: ["secret://other_key"] },
        {
          name: "ghostCall",
          kind: "action",
          file: "functions/integrations/ghost/call.ts",
          egress: ["x.example.ru"],
        },
      ],
    } as AppSpec;
    const issues = integrationEgressIssues(widened, [c]).map((i) => i.message_ru);
    expect(issues.join("\n")).toMatch(/evil\.example\.ru/);
    expect(issues.join("\n")).toMatch(/other_key/);
    expect(issues.join("\n")).toMatch(/без контракта/);
  });
});

describe("build layer", () => {
  const brief = systemBriefSchema.parse({
    integrations: [
      { id: "crm", name: "Partner CRM", direction: "out" },
      { id: "delivery", name: "Служба доставки", direction: "out" },
      { id: "onec", name: "1С: Бухгалтерия", direction: "in" },
    ],
  });

  test("contracts → code in their mode; notes for a missing contract, the mock and the incoming API", () => {
    const c = crm();
    const layer = integrationLayer({
      brief,
      contracts: [{ contract: c, version: 1, sha256: contractHash(c), mode: "mock" }],
    });
    expect(Object.keys(layer.files).length).toBeGreaterThan(3);
    expect(layer.notes.join("\n")).toMatch(/Служба доставки.*нет контракта/);
    expect(layer.notes.join("\n")).toMatch(/мок/);
    expect(layer.notes.join("\n")).toMatch(/1С.*ключ доступа/);
    const live = integrationLayer({
      brief,
      contracts: [{ contract: c, version: 1, sha256: contractHash(c), mode: "live" }],
    });
    expect(live.fingerprint).not.toBe(layer.fingerprint);
    expect(live.functions.every((f) => f.egress?.[0] === CRM_HOST)).toBe(true);
  });

  test("merge: replaces integration files and functions of the backend, keeps the rest; refuses a D37 breach", () => {
    const c = crm();
    const layer = integrationLayer({
      brief,
      contracts: [{ contract: c, version: 2, sha256: contractHash(c), mode: "live" }],
    });
    const base = {
      spec: {
        ...emptySpec("CRM"),
        functions: [
          { name: "ownFn", kind: "query", file: "functions/own.ts" },
          { name: "crmOld", kind: "action", file: "functions/integrations/crm/old.ts" },
        ],
      } as AppSpec,
      files: { "functions/own.ts": "x", "functions/integrations/crm/old.ts": "y" },
    };
    const merged = withIntegrationLayer(base, layer, [c]);
    expect(merged.spec.functions?.map((f) => f.name)).toContain("ownFn");
    expect(merged.spec.functions?.map((f) => f.name)).not.toContain("crmOld");
    expect(merged.files["functions/integrations/crm/old.ts"]).toBeUndefined();
    expect(merged.files["functions/own.ts"]).toBe("x");
    const tampered = {
      ...layer,
      functions: layer.functions.map((f) => ({ ...f, egress: ["evil.example.ru"] })),
    };
    expect(() => withIntegrationLayer(base, tampered, [c])).toThrow(/evil/);
  });
});
