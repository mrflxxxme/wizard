// V4-15 token sliders (D79 (9), the first layer): radius, density, contrast and the font pair of the client's design
// system — no model. The effective design (the latest hook's tokens over the design stage's, as the harness v3 merges
// them) is changed, ui/design.css rebuilt from it and committed as a new draft revision with its preview, and the
// design is saved into the build's checkpoints: the next build reuses it.
import { DESIGN_CSS_FILE, designCss } from "@wizard/agents/builder";
import { fontStack } from "@wizard/ui-kit/fonts";
import { ARCHETYPES, type DesignSystemV3, RADIUS_SETS, SECTION_SPACE } from "@wizard/ui-kit/v3/design";
import type postgres from "postgres";
import { invalid } from "../../errors.js";
import { type CommitPreview, commitAndPreview, type EditDeps } from "./literals.js";

export const RADII = ["sharp", "crisp", "soft", "round"] as const;
export const DENSITIES = ["compact", "regular", "airy"] as const;
/** normal — the direction's palette; high — secondary text as strong as the main one (never below AA either way). */
export const CONTRASTS = ["normal", "high"] as const;

export interface DesignControls {
  radius: (typeof RADII)[number];
  density: (typeof DENSITIES)[number];
  contrast: (typeof CONTRASTS)[number];
  /** `<display>+<text>` — one of the direction's font pairs. */
  fontPair: string;
}

export interface DesignControlsView extends DesignControls {
  fontPairs: { id: string; label: string }[];
}

/** Checkpoints whose design the harness merges, later ones over earlier (run.ts: design, then the hooks). */
const DESIGN_KEYS = ["design", "critic", "template_gate", "techreview"] as const;

/** Gutters by density, as designSystemV3 sets them. */
const GUTTER = {
  compact: { mobile: 16, desktop: 32 },
  regular: { mobile: 16, desktop: 40 },
  airy: { mobile: 20, desktop: 48 },
} as const;

type Checkpoint = { key: string; fingerprint?: string; data?: Record<string, unknown> } & Record<
  string,
  unknown
>;

/** The effective design system of the system's build and the checkpoints that hold a design. */
export async function effectiveDesign(
  pg: postgres.Sql,
  systemId: string,
): Promise<{ design: DesignSystemV3; holders: Checkpoint[] } | null> {
  const rows = await pg<{ key: string; checkpoint: Checkpoint }[]>`
    select c.key, c.checkpoint from platform.system_build_checkpoints c
    where c.system_id = ${systemId} and c.key = any(${[...DESIGN_KEYS]})`;
  const holders = DESIGN_KEYS.flatMap((k) => {
    const cp = rows.find((r) => r.key === k)?.checkpoint;
    const ds = cp?.data?.design as DesignSystemV3 | undefined;
    return cp && ds?.version === 3 ? [cp] : [];
  });
  const last = holders.at(-1);
  return last ? { design: last.data?.design as DesignSystemV3, holders } : null;
}

const pairId = (display: string, text: string) => `${display}+${text}`;

export function designControls(ds: DesignSystemV3): DesignControlsView {
  const a = ARCHETYPES.find((x) => x.id === ds.archetype);
  const own = pairId(ds.fonts.display.family, ds.fonts.text.family);
  const pairs = (a?.fontPairs ?? []).map((p) => ({
    id: pairId(p.display, p.text),
    label: `${p.display} и ${p.text}`,
  }));
  if (!pairs.some((p) => p.id === own))
    pairs.unshift({ id: own, label: `${ds.fonts.display.family} и ${ds.fonts.text.family}` });
  return {
    radius: ds.radius.set,
    density: ds.grid.rhythm.density,
    contrast: ds.palette.light.muted === ds.palette.light.ink ? "high" : "normal",
    fontPair: own,
    fontPairs: pairs,
  };
}

/** The design with the controls applied (the rest of it as it was). */
export function applyControls(
  ds: DesignSystemV3,
  c: Partial<DesignControls>,
  original?: DesignSystemV3,
): DesignSystemV3 {
  let out: DesignSystemV3 = structuredClone(ds);
  if (c.radius) {
    const [sm, md, lg] = RADIUS_SETS[c.radius];
    const pill = ds.radius.control > ds.radius.lg;
    out = { ...out, radius: { set: c.radius, sm, md, lg, control: pill ? ds.radius.control : md } };
  }
  if (c.density)
    out = {
      ...out,
      grid: {
        ...out.grid,
        gutter: { ...GUTTER[c.density] },
        rhythm: { density: c.density, section: { ...SECTION_SPACE[c.density] } },
      },
    };
  if (c.fontPair) {
    const [display, text] = c.fontPair.split("+");
    if (!display || !text || !designControls(ds).fontPairs.some((p) => p.id === c.fontPair))
      throw invalid("Такой пары шрифтов нет у этого стиля");
    out = {
      ...out,
      fonts: {
        display: { family: display, weight: ds.fonts.display.weight, stack: fontStack(display) },
        text: { family: text, weight: ds.fonts.text.weight, stack: fontStack(text) },
      },
    };
  }
  if (c.contrast) {
    const base = original ?? ds;
    const scheme = (s: "light" | "dark") =>
      c.contrast === "high"
        ? { ...out.palette[s], muted: out.palette[s].ink }
        : {
            ...out.palette[s],
            muted:
              base.palette[s].muted === base.palette[s].ink ? out.palette[s].muted : base.palette[s].muted,
          };
    out = { ...out, palette: { ...out.palette, light: scheme("light"), dark: scheme("dark") } };
  }
  return out;
}

/** The sliders: ui/design.css of the changed design as a new draft revision with its preview; the design saved. */
export async function editDesign(
  d: EditDeps & { pg: postgres.Sql },
  o: { systemId: string; userId: string; revision: number; controls: Partial<DesignControls> },
): Promise<CommitPreview & { controls: DesignControlsView }> {
  const started = (d.now ?? Date.now)();
  const eff = await effectiveDesign(d.pg, o.systemId);
  if (!eff) throw invalid("Стиль появится после первой сборки");
  const first = eff.holders[0]?.data?.design as DesignSystemV3;
  const next = applyControls(eff.design, o.controls, first);
  const out = await commitAndPreview(d, {
    systemId: o.systemId,
    userId: o.userId,
    revision: o.revision,
    changes: new Map([[DESIGN_CSS_FILE, designCss(next)]]),
    summaryRu: "Стиль: скругление, плотность, контраст или шрифты",
    inheritG0: true,
    kind: "style",
    started,
  });
  // The next build reuses the checkpoints: every one holding a design gets the new one.
  for (const cp of eff.holders) {
    const updated = { ...cp, data: { ...(cp.data ?? {}), design: next } };
    await d.pg`
      update platform.system_build_checkpoints set checkpoint = ${d.pg.json(updated as never)}, updated_at = now()
      where system_id = ${o.systemId} and key = ${cp.key}`;
  }
  return { ...out, controls: designControls(next) };
}
