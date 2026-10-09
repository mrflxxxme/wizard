// V3-15: test material of the techreview, built by code. A repair workshop brief (leads → deals with the person in
// charge → notifications, two staff roles) whose backend is compiled by the module catalog like the harness does
// (compileBackend), plus an extension function in functions/custom/** — the builder's code the reviewer may patch —
// and recorded answers of the reviewer (suite demo: answers by order; usage from the real digest prompt, so the cost is
// the models.yaml price of the reviewer's model).
import type { ExtensionOp, SystemBriefInput } from "@wizard/appspec";
import { systemBriefSchema } from "@wizard/appspec";
import {
  createRegistry,
  createRouter,
  type FixtureLine,
  type Registry,
  type RouteInput,
  type RouteOutput,
} from "@wizard/llm";
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import {
  briefNiche,
  briefPlan,
  compileBackend,
  DESIGN_CSS_FILE,
  designCss,
  submitTechreview,
  type TechreviewInput,
  techDigest,
  techreviewMessages,
  type V3BuildContext,
  V3Wallet,
} from "../src/builder/index.js";
import type { RouteFn } from "../src/core/loop.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";
import { fixtureLine } from "./build-v2-fixtures.js";
import { writeFixture } from "./v3-harness-fixtures.js";

/** A repair workshop: requests from the site become deals with a person in charge; the team is notified. */
export function workshopBrief(): SystemBriefInput {
  type Scenario = NonNullable<SystemBriefInput["scenarios"]>[number];
  const scenario = (s: Pick<Scenario, "id" | "actor" | "when" | "moduleHint">, steps: string[]): Scenario =>
    // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
    ({ ...s, then: steps });
  return {
    goals: [{ id: "g_leads", text: "Заявки на ремонт с сайта", success: "20 заявок в неделю" }],
    audience: "Владельцы ноутбуков и телефонов в районе, пишут с телефона",
    scenarios: [
      scenario(
        {
          id: "s_lead",
          actor: "visitor",
          when: "посетитель оставляет заявку на ремонт",
          moduleHint: "leads",
        },
        ["сохраняет заявку", "уведомляет мастера"],
      ),
      scenario({ id: "s_deal", actor: "staff", when: "мастер берёт заявку в работу", moduleHint: "deals" }, [
        "создаёт сделку",
        "назначает ответственного",
      ]),
      scenario({ id: "s_notify", actor: "system", when: "появилась новая заявка", moduleHint: "notify" }, [
        "пишет владельцу",
      ]),
    ],
    roles: [
      { id: "admin", name: "Администратор", can: ["принимает заявки"] },
      { id: "master", name: "Мастер", can: ["ведёт ремонт"] },
    ],
    data: [],
    design: { archetype: "warm_craft", references: [] },
  };
}

/** The extension function the reviewer may patch. */
export const CUSTOM_FILE = "functions/custom/repairStatus.ts";

/** A query that reads a lead without the «not found» case: strict TypeScript refuses it (G0-TS-01). */
export const BROKEN_SOURCE = `// Extension: the status of a repair request for the cabinet.
import { query, v } from "@wizard/sdk";

export default query({
  args: { id: v.id("lead") },
  handler: async (ctx, args) => {
    const lead = await ctx.db.lead.get(args.id);
    return { status: lead.status };
  },
});
`;

/** The same query with the «not found» case handled. */
export const FIXED_SOURCE = `// Extension: the status of a repair request for the cabinet.
import { query, v } from "@wizard/sdk";

export default query({
  args: { id: v.id("lead") },
  handler: async (ctx, args) => {
    const lead = await ctx.db.lead.get(args.id);
    if (!lead) return { status: null };
    return { status: lead.status };
  },
});
`;

/** A patch that breaks the build: it reads a field the lead does not have. */
export const BAD_PATCH = `// Extension: the status of a repair request for the cabinet.
import { query, v } from "@wizard/sdk";

export default query({
  args: { id: v.id("lead") },
  handler: async (ctx, args) => {
    const lead = await ctx.db.lead.get(args.id);
    if (!lead) return { status: null };
    return { status: lead.repairStage };
  },
});
`;

/** The extension operation that adds the query (C5 add_function). */
export const repairStatus = (source: string): ExtensionOp => ({
  op: "add_function",
  name: "repairStatus",
  kind: "query",
  source,
  public: true,
  roles: ["owner"],
});

/** The build context the harness hands the techreview: the workshop backend, its design CSS and extra files. */
export function workshopCtx(o: {
  route: RouteFn;
  budgetRub?: number;
  extensions?: readonly unknown[];
  files?: Record<string, string>;
  /** Another brief (default — the workshop). */
  brief?: SystemBriefInput;
}): V3BuildContext {
  const brief = systemBriefSchema.parse(o.brief ?? workshopBrief());
  const bp = briefPlan(brief, DEFAULT_REGISTRY, [], { appName: "Мастерская" });
  if (!bp) throw new Error("workshop brief: no plan");
  const design = designSystemV3({ archetype: "warm_craft", seed: "workshop", niche: briefNiche(brief) });
  const r = compileBackend({
    plan: bp.plan,
    registry: DEFAULT_REGISTRY,
    extensions: o.extensions ?? [repairStatus(FIXED_SOURCE)],
    design,
    options: { appName: "Мастерская" },
  });
  if (!r.ok) throw new Error(r.message_ru);
  const files = new Map<string, string>(Object.entries(r.files));
  files.set(DESIGN_CSS_FILE, designCss(design));
  for (const [p, s] of Object.entries(o.files ?? {})) files.set(p, s);
  return {
    systemId: "sys-workshop",
    brief,
    briefVersion: 1,
    plan: r.plan,
    spec: r.spec,
    publicFront: r.publicFront,
    design,
    files,
    route: o.route,
    budgetRub: o.budgetRub ?? 60,
  };
}

/** A recorded reviewer answer with the usage of the digest prompt of `ctx`. */
export function reviewLine(ctx: V3BuildContext, args: TechreviewInput, round = 1): FixtureLine {
  const digest = techDigest({
    brief: ctx.brief,
    plan: ctx.plan,
    system: { spec: ctx.spec, files: ctx.files },
    reference: null,
    checks: [],
    fixes: [],
  });
  return fixtureLine("techreview", techreviewMessages(digest, round, 2), [submitTechreview.definition], {
    name: "submit_techreview",
    args,
  });
}

/** A reviewer finding of the closed set. */
export function finding(
  f: Partial<TechreviewInput["findings"][number]> & Pick<TechreviewInput["findings"][number], "title_ru">,
): TechreviewInput["findings"][number] {
  return {
    severity: "blocker",
    area: "errors",
    evidence: { kind: "file", ref: CUSTOM_FILE },
    fix: { kind: "none" },
    ...f,
  };
}

export const OPEN = { ruOnly: false, t1Restricted: false };

/** The stage wallet's route over a fixture router: what the harness hands a hook (ctx.route). */
export function walletRoute(o: {
  lines: readonly FixtureLine[];
  budgetRub?: number;
  reg?: Registry;
  /** Every RouteInput the router got (avoidFamilies, callType). */
  seen?: RouteInput[];
  outs?: RouteOutput[];
}): { route: RouteFn; wallet: V3Wallet } {
  const reg = o.reg ?? createRegistry({ buildDefaultTier: "T1" });
  const dir = writeFixture("techreview", o.lines);
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: "v3/techreview", dir },
    registry: reg,
    sink: { write: async () => {} },
    env: {},
  });
  const wallet = new V3Wallet("techreview", o.budgetRub ?? 60, 500, reg.rubPerCredit);
  const route = wallet.route(
    {
      route: async (input) => {
        const { step: _s, upperBoundCredits: _u, ...rest } = input;
        const full = { ...rest, orgPolicy: OPEN, ctx: { orgId: "org" } } as RouteInput;
        o.seen?.push(full);
        const out = await router.route(full);
        o.outs?.push(out);
        return out;
      },
    },
    reg,
  );
  return { route, wallet };
}
