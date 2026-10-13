// V4-15 routes of instant edits (the owner's session): GET /systems/:id/edit/literals — the texts and photos of the
// draft's pages by ref (viewer); POST — replace them, no model, a new draft revision and its preview (editor).
// GET /systems/:id/edit/design — the sliders of the design system (radius, density, contrast, font pair); POST — change
// them: ui/design.css rebuilt, a new revision with its preview, the design saved for the next build.
import { Hono } from "hono";
import type postgres from "postgres";
import { z } from "zod";
import { notFound } from "../../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../../http/auth.js";
import { jsonBody } from "../../http/util.js";
import {
  CONTRASTS,
  DENSITIES,
  designControls,
  designPreview,
  editDesign,
  effectiveDesign,
  RADII,
} from "./design.js";
import { draftLiterals, type EditDeps, editLiterals } from "./literals.js";

const REF = z.string().regex(/^[0-9a-f]{8}:\d{1,7}$/);

export function editRoutes(d: EditDeps & { pg: postgres.Sql }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const system = async (id: string) => {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "name", "draft_revision"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    return s;
  };

  r.get("/systems/:id/edit/literals", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "viewer", "Система");
    return c.json({ revision: s.draft_revision, literals: await draftLiterals(d, s, s.draft_revision) });
  });

  r.post("/systems/:id/edit/literals", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "editor", "Система");
    const b = await jsonBody(
      c,
      z.strictObject({
        revision: z.number().int().min(1),
        edits: z
          .array(z.strictObject({ ref: REF, value: z.string().max(2000) }))
          .min(1)
          .max(20),
      }),
    );
    const out = await editLiterals(d, {
      systemId: s.id,
      userId: c.get("user").id,
      revision: b.revision,
      edits: b.edits,
    });
    return c.json(out);
  });

  r.get("/systems/:id/edit/design", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "viewer", "Система");
    const eff = await effectiveDesign(d.pg, s.id);
    if (!eff) throw notFound("Стиль");
    const first = eff.holders[0]?.data?.design as Parameters<typeof designPreview>[1];
    return c.json({
      revision: s.draft_revision,
      ...designControls(eff.design),
      preview: designPreview(eff.design, first),
    });
  });

  r.post("/systems/:id/edit/design", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "editor", "Система");
    const b = await jsonBody(
      c,
      z.strictObject({
        revision: z.number().int().min(1),
        radius: z.enum(RADII).optional(),
        density: z.enum(DENSITIES).optional(),
        contrast: z.enum(CONTRASTS).optional(),
        fontPair: z.string().max(120).optional(),
      }),
    );
    const { revision, ...controls } = b;
    const out = await editDesign(d, { systemId: s.id, userId: c.get("user").id, revision, controls });
    return c.json(out);
  });

  return r;
}
