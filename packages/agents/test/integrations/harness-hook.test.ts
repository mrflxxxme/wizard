// V3-20 acceptance 2 (build side): the harness v3 with V3Host.integrations — without a key the build commits the
// integration on the mock (no egress, no key, no network code); after the key check the next build switches it on
// (egress = the contract's hosts, secret://) without paying again for the reused steps. Recorded answers, no network.
import { type AppSpec, emptySpec, type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { createRegistry, createRouter, type RouteInput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  briefNiche,
  runBuildV3,
  type V3Checkpoint,
  type V3Host,
  type V3Outcome,
} from "../../src/builder/index.js";
import {
  contractFromOpenApi,
  contractHash,
  integrationsHook,
  type StoredContract,
} from "../../src/integrations/index.js";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "../v3-harness-fixtures.js";
import { CRM_HOST, crmOpenApi } from "./fixtures.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const reg = createRegistry({ buildDefaultTier: "T1" });

interface Sys {
  brief: SystemBriefInput;
  version: number;
  spec: AppSpec;
  files: Record<string, string>;
  checkpoints: Map<string, V3Checkpoint>;
  calls: string[];
}

function host(sys: Sys, read: () => Promise<StoredContract[]>): { host: V3Host; clock: { t: number } } {
  const clock = { t: 0 };
  const brief = systemBriefSchema.parse(sys.brief);
  const dir = writeFixture(
    "clinic-integrations",
    v3Lines({
      brief: { goals: brief.goals, audience: brief.audience },
      niche: briefNiche(brief),
      seed: "sys-int",
      artDirection: false,
      pages: 30,
      prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
    }),
  );
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: "v3/clinic-integrations", dir },
    registry: reg,
    sink: { write: async () => {} },
    env: {},
  });
  const pass = (level: string): GateReport => ({
    level: level as GateReport["level"],
    passed: true,
    specVersion: sys.version,
    startedAt: "2026-10-09T00:00:00.000Z",
    durationMs: 1,
    checks: [],
    summary: { pass: 1, fail: 0, warn: 0, skip: 0, error: 0 },
  });
  return {
    clock,
    host: {
      run: { id: `run-${Math.random().toString(16).slice(2)}` },
      systemId: "sys-int",
      runStep: (_n, fn) => fn(),
      emit: () => {},
      route: async (input) => {
        const { step: _s, upperBoundCredits: _u, ...rest } = input;
        sys.calls.push(input.callType);
        clock.t += 1000;
        return router.route({ ...rest, orgPolicy: OPEN, ctx: { orgId: "org" } } as RouteInput);
      },
      brief: async () => ({ version: 1, brief }),
      checkpoints: {
        load: async () => [...sys.checkpoints.values()].map((c) => structuredClone(c)),
        save: async (cp) => {
          sys.checkpoints.set(cp.key, JSON.parse(JSON.stringify(cp)) as V3Checkpoint);
        },
      },
      currentSpec: async () => ({ spec: sys.spec, version: sys.version }),
      commit: async ({ spec, files }) => {
        sys.version += 1;
        sys.spec = spec;
        sys.files = { ...files };
        return { revision: sys.version };
      },
      runGates: async (level) => pass(level),
      composer: fakeComposer(),
      integrations: integrationsHook(read),
    },
  };
}

async function build(
  sys: Sys,
  read: () => Promise<StoredContract[]>,
): Promise<Extract<V3Outcome, { status: "succeeded" }>> {
  const h = host(sys, read);
  const out = await runBuildV3(h.host, { now: () => h.clock.t, appName: "Клиника" });
  if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
  return out;
}

describe("harness v3 + integrations layer", () => {
  test("no key → the build runs on the mock; after the key check the next build switches the integration on", async () => {
    const contract = contractFromOpenApi(crmOpenApi(), {
      id: "crm",
      name: "Partner CRM",
      need: "заявки в CRM",
    });
    const stored: StoredContract = { contract, version: 1, sha256: contractHash(contract), mode: "mock" };
    const sys: Sys = {
      brief: { ...clinicBrief(), integrations: [{ id: "crm", name: "Partner CRM", direction: "out" }] },
      version: 0,
      spec: emptySpec("Клиника"),
      files: {},
      checkpoints: new Map(),
      calls: [],
    };
    const first = await build(sys, async () => [stored]);
    const fns = (sys.spec.functions ?? []).filter((f) => f.file.startsWith("functions/integrations/crm/"));
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining(["crmCreateLead", "crmListLeads"]));
    expect(fns.every((f) => f.egress === undefined && f.secretRefs === undefined)).toBe(true);
    expect(sys.files["functions/integrations/crm/client.ts"]).toContain('MODE = "mock"');
    expect(Object.values(sys.files).join("\n")).not.toContain("secret://crm_key");
    expect(first.summary_ru).toMatch(/мок/);
    // Module functions of the backend survive the layer.
    expect((sys.spec.functions ?? []).some((f) => !f.file.startsWith("functions/integrations/"))).toBe(true);

    // The key passed its check: the same contract, now live — the scenarios are reused, nothing is paid again.
    const callsBefore = sys.calls.length;
    const second = await build(sys, async () => [{ ...stored, mode: "live" }]);
    const live = (sys.spec.functions ?? []).filter((f) => f.file.startsWith("functions/integrations/crm/"));
    expect(live.length).toBe(fns.length);
    expect(
      live.every((f) => f.egress?.join() === CRM_HOST && f.secretRefs?.join() === "secret://crm_key"),
    ).toBe(true);
    expect(sys.files["functions/integrations/crm/client.ts"]).toContain(
      `ctx.http.fetch(\`https://${CRM_HOST}/v2/`,
    );
    expect(sys.calls.length).toBe(callsBefore);
    expect(second.summary_ru).not.toMatch(/мок/);
  }, 60_000);

  test("a brief without integrations is untouched by the hook", async () => {
    let reads = 0;
    const sys: Sys = {
      brief: clinicBrief(),
      version: 0,
      spec: emptySpec("Клиника"),
      files: {},
      checkpoints: new Map(),
      calls: [],
    };
    await build(sys, async () => {
      reads++;
      return [];
    });
    expect(reads).toBe(0);
    expect(Object.keys(sys.files).some((p) => p.startsWith("functions/integrations/"))).toBe(false);
  }, 60_000);
});
