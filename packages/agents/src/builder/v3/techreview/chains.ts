// End-to-end chains between modules (V3-15 deterministic part): lead → owner notice, lead → deal → the responsible
// person, booking → notice and reminder, booking → client card and package write-off, issue → item status and the
// return reminder, package → its end reminder, order → stock (when such modules exist). Each link is an automation of
// the spec: a trigger on the chain's entity and a step (notify through a connected channel, a function that exists).
// The reference is the plan compiled by the module catalog: a link the catalog makes but the system lost is a blocker
// (the build broke it); a link the catalog does not make is a warning (a gap the reviewer may close by an extension).
// A link is covered by an acceptance scenario that creates the entity and runs the automations (G1 through the
// runtime, the final gates); the latest G1 of the draft is evidence.
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { compilePlan, type ModuleRegistry } from "@wizard/modules";
import type { TechCheck } from "./types.js";

export interface ChainLink {
  label_ru: string;
  /** Entities whose automation makes the link. */
  entities: readonly string[];
  /** Trigger types (absent — any). */
  triggers?: readonly string[];
  step: "notify" | "function" | "update" | "create";
  /** The function a function step calls. */
  fn?: string;
}

export interface ChainDef {
  id: string;
  title_ru: string;
  /** All of them in the plan → the chain applies. */
  modules: readonly string[];
  links: readonly ChainLink[];
}

/** The chains of the module catalog (modules.yaml links), in the order the digest shows them. */
export const CHAINS: readonly ChainDef[] = [
  {
    id: "lead_owner",
    title_ru: "Заявка → уведомление владельцу",
    modules: ["leads", "notify"],
    links: [
      { label_ru: "уведомление о новой заявке", entities: ["lead"], triggers: ["on_create"], step: "notify" },
    ],
  },
  {
    id: "lead_deal_responsible",
    title_ru: "Заявка → сделка → уведомление ответственному",
    modules: ["leads", "deals", "notify"],
    links: [
      {
        label_ru: "заявка в работе становится сделкой",
        entities: ["lead"],
        step: "function",
        fn: "dealFromLead",
      },
      {
        label_ru: "ответственный узнаёт о сделке или её задаче",
        entities: ["deal", "deal_task"],
        step: "notify",
      },
    ],
  },
  {
    id: "lead_client",
    title_ru: "Заявка → карточка клиента",
    modules: ["leads", "client_card"],
    links: [{ label_ru: "клиент по заявке", entities: ["lead"], step: "function", fn: "clientFromLead" }],
  },
  {
    id: "booking_notify",
    title_ru: "Запись → уведомление и напоминание",
    modules: ["booking", "notify"],
    links: [
      {
        label_ru: "уведомление о новой записи",
        entities: ["booking"],
        triggers: ["on_create"],
        step: "notify",
      },
      { label_ru: "напоминание до визита", entities: ["booking"], triggers: ["schedule"], step: "notify" },
    ],
  },
  {
    id: "booking_client",
    title_ru: "Запись → карточка клиента",
    modules: ["booking", "client_card"],
    links: [
      { label_ru: "клиент по записи", entities: ["booking"], step: "function", fn: "clientFromBooking" },
    ],
  },
  {
    id: "booking_package",
    title_ru: "Запись → списание визита с абонемента",
    modules: ["booking", "packages"],
    links: [{ label_ru: "списание по записи", entities: ["booking"], step: "function", fn: "writeOffVisit" }],
  },
  {
    id: "issue_item",
    title_ru: "Выдача → статус предмета",
    modules: ["resources"],
    links: [
      {
        label_ru: "выдача занимает предмет",
        entities: ["resource_issue"],
        triggers: ["on_create"],
        step: "function",
      },
      {
        label_ru: "возврат освобождает предмет",
        entities: ["resource_issue"],
        triggers: ["on_status"],
        step: "function",
      },
    ],
  },
  {
    id: "issue_reminder",
    title_ru: "Выдача → напоминание о возврате",
    modules: ["resources", "notify"],
    links: [{ label_ru: "напоминание о сроке возврата", entities: ["resource_issue"], step: "notify" }],
  },
  {
    id: "package_reminder",
    title_ru: "Абонемент → напоминание об окончании",
    modules: ["packages", "notify"],
    links: [{ label_ru: "напоминание об окончании", entities: ["client_package"], step: "notify" }],
  },
  {
    id: "order_stock",
    title_ru: "Заказ → остаток на складе",
    modules: ["orders", "stock"],
    links: [{ label_ru: "заказ списывает остаток", entities: ["order"], step: "function" }],
  },
];

type Workflow = NonNullable<AppSpec["workflows"]>[number];
type Step = Workflow["steps"][number];
const params = (s: Step) => (s.params ?? {}) as Record<string, unknown>;

/** The automation that makes the link: [workflow index, step index] or null. */
export function findLink(spec: AppSpec, link: ChainLink): [number, number] | null {
  const ws = spec.workflows ?? [];
  for (const [i, w] of ws.entries()) {
    if (!w.trigger.entity || !link.entities.includes(w.trigger.entity)) continue;
    if (link.triggers && !link.triggers.includes(w.trigger.type)) continue;
    const j = w.steps.findIndex((s) => s.type === link.step && (!link.fn || params(s).name === link.fn));
    if (j >= 0) return [i, j];
  }
  return null;
}

/** Why a found link does not work: the channel, the template or the function it needs is missing. */
function brokenLink(spec: AppSpec, files: ReadonlyMap<string, string>, step: Step): string | null {
  const p = params(step);
  if (step.type === "notify") {
    const integ = (spec.integrations ?? []).find((x) => x.name === p.integration);
    if (!integ) return `канала «${String(p.integration)}» нет среди подключений`;
    if (integ.connector === "email" && typeof p.template === "string") {
      const templates = ((integ.config ?? {}) as { templates?: Record<string, unknown> }).templates ?? {};
      if (!Object.hasOwn(templates, p.template)) return `шаблона письма «${p.template}» нет`;
    }
    return null;
  }
  if (step.type === "function") {
    const fn = (spec.functions ?? []).find((f) => f.name === p.name);
    if (!fn) return `функции «${String(p.name)}» нет в системе`;
    if (!files.has(fn.file)) return `файла функции ${fn.file} нет`;
  }
  return null;
}

/** Acceptance scenarios that create one of the entities and run the automations — they exercise the link in G1. */
export function coveringAcceptance(spec: AppSpec, entities: readonly string[]): string[] {
  const out: string[] = [];
  for (const ac of spec.acceptance ?? []) {
    const check = (ac as { check?: { type?: string; steps?: unknown[] } }).check;
    if (check?.type !== "scenario") continue;
    const steps = (check.steps ?? []) as Record<string, unknown>[];
    const creates = steps.some((s) => {
      const c = s.create as { entity?: string } | undefined;
      return typeof c?.entity === "string" && entities.includes(c.entity);
    });
    const runs = steps.some((s) => "runWorkflows" in s || "advanceTime" in s);
    if (creates && runs) out.push(String((ac as { id?: string }).id ?? ""));
  }
  return out.filter(Boolean);
}

/** Acceptance ids that failed in the evidence G1 reports. */
function failedAcceptance(reports: readonly GateReport[]): Set<string> {
  const out = new Set<string>();
  for (const r of reports)
    if (r.level === "G1")
      for (const c of r.checks) if ((c.status === "fail" || c.status === "error") && c.acId) out.add(c.acId);
  return out;
}

/** The reference spec of the plan: what the module catalog makes (null — the plan does not compile here). */
export function referenceSpec(plan: SystemPlan, registry: ModuleRegistry): AppSpec | null {
  try {
    const r = compilePlan(plan, registry, { front: "backend" });
    return r.ok ? r.spec : null;
  } catch {
    return null;
  }
}

/** One check per chain of the plan's modules. */
export function chainChecks(o: {
  plan: SystemPlan;
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  reference: AppSpec | null;
  evidence: readonly GateReport[];
}): TechCheck[] {
  const present = new Set(o.plan.modules.map((m) => m.id));
  const failedAc = failedAcceptance(o.evidence);
  const out: TechCheck[] = [];
  for (const chain of CHAINS) {
    if (!chain.modules.every((m) => present.has(m))) continue;
    const id = `TR-CHAIN-${chain.id}`;
    const problems: { level: "fail" | "warn"; text: string; ref?: string }[] = [];
    let ref: string | undefined;
    for (const link of chain.links) {
      const cur = findLink(o.spec, link);
      if (cur) {
        const [wi, si] = cur;
        const pointer = `/workflows/${wi}/steps/${si}`;
        ref ??= `/workflows/${wi}`;
        const step = o.spec.workflows?.[wi]?.steps[si] as Step;
        const why = brokenLink(o.spec, o.files, step);
        if (why)
          problems.push({
            level: "fail",
            text: `звено «${link.label_ru}» не сработает: ${why}`,
            ref: pointer,
          });
        continue;
      }
      const inRef = o.reference ? findLink(o.reference, link) : null;
      if (inRef)
        problems.push({
          level: "fail",
          text: `звено «${link.label_ru}» потеряно при сборке — модули его делают, а в системе автоматизации нет`,
        });
      else
        problems.push({
          level: "warn",
          text: `звено «${link.label_ru}» модули этой системы не замыкают — его можно добавить доработкой`,
        });
    }
    const covering = coveringAcceptance(
      o.spec,
      chain.links.flatMap((l) => l.entities),
    );
    const failedHere = covering.filter((a) => failedAc.has(a));
    if (failedHere.length)
      problems.push({
        level: "warn",
        text: `на последней проверке G1 не прошёл сценарий ${failedHere.join(", ")} — финальная проверка решит`,
      });
    const fail = problems.some((p) => p.level === "fail");
    const warn = problems.some((p) => p.level === "warn");
    const covered = covering.length ? ` Проверяется сценарием G1: ${covering.join(", ")}.` : "";
    const at = problems.find((p) => p.ref)?.ref ?? ref;
    out.push({
      id,
      area: "chains",
      status: fail ? "fail" : warn ? "warn" : "pass",
      severity: fail ? "blocker" : "warning",
      message_ru: problems.length
        ? `${chain.title_ru}: ${problems.map((p) => p.text).join("; ")}.${covered}`
        : `${chain.title_ru}: все звенья на месте.${covered}`,
      ...(at ? { ref: at } : {}),
    });
  }
  return out;
}
