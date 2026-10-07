// Canvas model (B2-25): the plan sketch (api.yaml#PlanSketch) → frames «Сайт», «Кабинет», «Телефон» with blocks of the
// plan's modules and landing sections, goal and «не входит» tags, the order of materialization. Pure and deterministic:
// the same sketch gives the same board; block ids stay stable between sketches so a new block is «born» and a changed
// one is «touched».
import type { PlanSketch } from "../../api/types.js";
import { canvas } from "../../i18n/ru/canvas.js";

export type FrameId = "site" | "cab" | "phone";

export type BlockKind =
  | "nav"
  | "hero"
  | "services"
  | "steps"
  | "features"
  | "faq"
  | "cta"
  | "lead_form"
  | "booking"
  | "section"
  | "goals"
  | "schedule"
  | "client"
  | "leads"
  | "deals"
  | "staff"
  | "module"
  | "notifications"
  | "mobile";

export interface BlockTag {
  kind: "goal" | "out" | "plain";
  label: string;
  note?: string;
}

export interface CanvasBlockModel {
  /** Stable key: "<frame>:<what>". */
  id: string;
  frame: FrameId;
  kind: BlockKind;
  /** Plain name of the block («Услуги и цены»): caption, pick label. */
  title: string;
  module?: string;
  tags: BlockTag[];
  /** Kind-specific content (texts of the plan or neutral sample data). */
  data: Record<string, unknown>;
}

export interface CanvasModel {
  stage: PlanSketch["stage"];
  frames: Record<FrameId, CanvasBlockModel[]>;
  /** Materialization order: site, phone, cabinet (what the visitor sees first). */
  order: string[];
  accent: string | null;
}

export interface LocalAnswer {
  module?: string;
  label: string;
}

const PUBLIC_MODULES = new Set(["landing", "catalog", "booking", "leads"]);

const param = (sk: PlanSketch, module: string, name: string): unknown =>
  sk.modules.find((m) => m.id === module)?.params.find((p) => p.name === name)?.value;

const has = (sk: PlanSketch, module: string) => sk.modules.some((m) => m.id === module);

function channels(sk: PlanSketch): string[] {
  const v = param(sk, "notify", "channels");
  return Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : ["email"];
}

function siteBlocks(sk: PlanSketch, name: string): CanvasBlockModel[] {
  const out: CanvasBlockModel[] = [];
  const publicScreens = sk.screens.filter((s) => s.audience === "public" && !s.route.includes(":"));
  const cta = has(sk, "booking") ? canvas.blocks.cta : has(sk, "leads") ? canvas.blocks.leadForm : undefined;
  const block = (b: Omit<CanvasBlockModel, "frame" | "tags">): CanvasBlockModel => ({
    ...b,
    frame: "site",
    tags: [],
  });
  out.push(
    block({
      id: "site:nav",
      kind: "nav",
      title: name,
      module: "landing",
      data: { name, links: publicScreens.filter((s) => s.route !== "/").map((s) => s.title), cta },
    }),
  );
  const sections = sk.sections.filter((s) => s.type !== "header" && s.type !== "footer");
  if (sk.stage === "plan" && sections.length > 0) {
    const seen = new Map<string, number>();
    for (const s of sections) {
      const n = (seen.get(s.type) ?? 0) + 1;
      seen.set(s.type, n);
      const id = `site:${s.type}${n > 1 ? `-${n}` : ""}`;
      const title = s.title ?? s.label;
      const kind: BlockKind = (
        ["hero", "services", "steps", "features", "faq", "cta", "lead_form", "booking"] as const
      ).includes(s.type as never)
        ? (s.type as BlockKind)
        : "section";
      out.push(
        block({
          id,
          kind,
          title: kind === "hero" ? s.label : title,
          module: s.type === "services" ? "catalog" : s.type === "lead_form" ? "leads" : "landing",
          data: { title, label: s.label, variant: s.variant, cta, sectionIndex: s.index },
        }),
      );
    }
  } else {
    if (has(sk, "landing") || sk.stage === "interview")
      out.push(
        block({ id: "site:hero", kind: "hero", title: "Первый экран", module: "landing", data: { cta } }),
      );
    if (has(sk, "catalog"))
      out.push(
        block({
          id: "site:services",
          kind: "services",
          title: canvas.blocks.services,
          module: "catalog",
          data: { title: canvas.blocks.services },
        }),
      );
  }
  // Module screens the landing does not cover: the booking and the lead form are their own blocks.
  const covered = new Set(out.map((b) => b.kind));
  if (has(sk, "booking") && !covered.has("booking")) {
    const many = param(sk, "booking", "with_specialists") === true;
    const spec = param(sk, "booking", "specialist_label");
    out.push(
      block({
        id: "site:booking",
        kind: "booking",
        title: publicScreens.find((s) => s.module === "booking")?.title ?? canvas.blocks.booking,
        module: "booking",
        data: {
          specialists: many ? canvas.sampleData.people : [],
          specialistLabel: typeof spec === "string" ? spec : "",
          dayEnd: param(sk, "booking", "day_end"),
        },
      }),
    );
  }
  if (has(sk, "leads") && !covered.has("lead_form"))
    out.push(
      block({
        id: "site:lead_form",
        kind: "lead_form",
        title: canvas.blocks.leadForm,
        module: "leads",
        data: { title: canvas.blocks.leadForm },
      }),
    );
  return out;
}

function cabinetBlocks(sk: PlanSketch): CanvasBlockModel[] {
  const out: CanvasBlockModel[] = [];
  const block = (b: Omit<CanvasBlockModel, "frame" | "tags">): CanvasBlockModel => ({
    ...b,
    frame: "cab",
    tags: [],
  });
  const screenTitle = (module: string, fallback: string) =>
    sk.screens.find((s) => s.audience === "cabinet" && s.module === module && s.route !== "/cabinet")
      ?.title ?? fallback;
  if (has(sk, "reports") || sk.metrics.length > 0) {
    // One metric per goal of the plan (a percentage first: it reads as a ring), in the order of the goals.
    const perGoal = sk.goals.flatMap((g) => {
      const own = sk.metrics.filter((m) => m.goal === g.id);
      const m = own.find((x) => x.unit === "percent") ?? own[0];
      return m ? [{ label: m.label, unit: m.unit, goal: g.id }] : [];
    });
    const metrics =
      perGoal.length > 0
        ? perGoal
        : sk.metrics.length > 0
          ? sk.metrics.map((m) => ({ label: m.label, unit: m.unit, goal: m.goal }))
          : sk.goals.map((g) => ({ label: g.label, unit: "percent", goal: g.id }));
    out.push(
      block({
        id: "cab:goals",
        kind: "goals",
        title: screenTitle("reports", canvas.blocks.goals),
        module: "reports",
        data: { metrics: metrics.slice(0, 3) },
      }),
    );
  }
  if (has(sk, "booking")) {
    const many = param(sk, "booking", "with_specialists") === true;
    out.push(
      block({
        id: "cab:schedule",
        kind: "schedule",
        title: canvas.blocks.schedule,
        module: "booking",
        data: {
          specialist: many ? (param(sk, "booking", "specialist_label") ?? "") : "",
          reminders: has(sk, "notify"),
        },
      }),
    );
  }
  if (has(sk, "leads"))
    out.push(
      block({
        id: "cab:leads",
        kind: "leads",
        title: screenTitle("leads", canvas.blocks.leads),
        module: "leads",
        data: {},
      }),
    );
  if (has(sk, "deals"))
    out.push(
      block({
        id: "cab:deals",
        kind: "deals",
        title: screenTitle("deals", canvas.blocks.deals),
        module: "deals",
        data: {},
      }),
    );
  if (has(sk, "client_card")) {
    const label = param(sk, "client_card", "client_label");
    out.push(
      block({
        id: "cab:client",
        kind: "client",
        title: screenTitle("client_card", canvas.blocks.clients),
        module: "client_card",
        data: { label: typeof label === "string" ? label : "" },
      }),
    );
  }
  if (has(sk, "staff"))
    out.push(
      block({
        id: "cab:staff",
        kind: "staff",
        title: screenTitle("staff", canvas.blocks.staff),
        module: "staff",
        data: {},
      }),
    );
  // Modules without a canvas picture yet (draft ones or new): a plain block with the module's name.
  const pictured = new Set([
    "landing",
    "catalog",
    "booking",
    "leads",
    "reports",
    "deals",
    "client_card",
    "staff",
    "notify",
    "visitor_cabinet",
  ]);
  for (const m of sk.modules)
    if (!pictured.has(m.id))
      out.push(
        block({
          id: `cab:module-${m.id}`,
          kind: "module",
          title: m.name,
          module: m.id,
          data: { summary: m.summary ?? "", soon: m.status === "soon" },
        }),
      );
  return out;
}

function phoneBlocks(sk: PlanSketch, name: string): CanvasBlockModel[] {
  const out: CanvasBlockModel[] = [];
  const block = (b: Omit<CanvasBlockModel, "frame" | "tags">): CanvasBlockModel => ({
    ...b,
    frame: "phone",
    tags: [],
  });
  if (has(sk, "notify"))
    out.push(
      block({
        id: "phone:notifications",
        kind: "notifications",
        title: canvas.blocks.notifications,
        module: "notify",
        data: { channels: channels(sk), name },
      }),
    );
  if (sk.modules.some((m) => PUBLIC_MODULES.has(m.id)))
    out.push(
      block({
        id: "phone:mobile",
        kind: "mobile",
        title: canvas.blocks.mobile,
        module: "landing",
        data: { name, booking: has(sk, "booking") },
      }),
    );
  return out;
}

/** The block a goal or «не входит» tag goes on: the first block of a module, else the first content block. */
function anchorFor(
  blocks: CanvasBlockModel[],
  modules: readonly (string | undefined)[],
): CanvasBlockModel | undefined {
  for (const m of modules) {
    const b = blocks.find(
      (x) => m !== undefined && x.module === m && x.kind !== "nav" && x.kind !== "mobile",
    );
    if (b) return b;
  }
  return undefined;
}

/** Builds the canvas from a sketch, plus the answers the client gave before the plan (tags on their modules). */
export function canvasModel(sk: PlanSketch, name: string, answers: readonly LocalAnswer[] = []): CanvasModel {
  const frames: Record<FrameId, CanvasBlockModel[]> = {
    site: siteBlocks(sk, name),
    cab: cabinetBlocks(sk),
    phone: phoneBlocks(sk, name),
  };
  const all = [...frames.site, ...frames.phone, ...frames.cab];
  for (const g of sk.goals) {
    const b = anchorFor(all, g.modules) ?? frames.site.find((x) => x.kind === "hero");
    b?.tags.push({ kind: "goal", label: canvas.tags.goal, note: g.statement || g.label });
  }
  for (const o of sk.outOfScope) {
    const b =
      anchorFor(all, [o.module, "booking", "leads", "catalog"]) ?? frames.site.find((x) => x.kind === "hero");
    b?.tags.push({
      kind: "out",
      label: o.request,
      ...(o.replacement ? { note: o.replacement } : {}),
    });
  }
  for (const a of answers) {
    const b = anchorFor(all, [a.module]);
    b?.tags.push({ kind: "plain", label: a.label });
  }
  for (const m of sk.modules)
    if (m.status === "soon") {
      const b = anchorFor(all, [m.id]);
      if (b && !b.tags.some((t) => t.label === canvas.tags.soon))
        b.tags.push({ kind: "plain", label: canvas.tags.soon });
    }
  return {
    stage: sk.stage,
    frames,
    order: all.map((b) => b.id),
    accent: sk.accent ?? null,
  };
}

/** Content signature of a block: a change between two sketches «touches» the block (amber edge). */
export function blockSignature(b: CanvasBlockModel): string {
  return JSON.stringify([b.kind, b.title, b.tags, b.data]);
}

/** States of the blocks during a build: the first ⌈fraction·N⌉ are ready, the next one is materializing. */
export function materializedCount(total: number, fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return total;
  return Math.min(total, Math.ceil(fraction * total));
}
