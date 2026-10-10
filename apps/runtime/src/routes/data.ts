// /api/data/:entity — CRUD by AppSpec (runtime.yaml#data_api) on top of DataAccess.
import { aiTargetFields } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { aiFilledFields } from "../ai/actions.js";
import type { FilterCond, FilterOp, ListQuery, SortKey } from "../data/access.js";
import { fieldsError, SEARCH_MAX } from "../data/validate.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { subjectOf } from "../http/subject.js";

export const MAX_BODY_BYTES = 1024 * 1024;
const OPS = new Set<FilterOp>(["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"]);
const FILTER_RE = /^filter\[([a-z_][a-z0-9_]*)\](?:\[([a-z]+)\])?$/;

const bad = (field: string, message: string) =>
  fieldsError("VALIDATION_FAILED", [{ field, code: "INVALID_QUERY", message }]);

function intParam(raw: string | null, name: string, def: number, min: number, max: number): number {
  if (raw === null || raw === "") return def;
  if (!/^\d{1,9}$/.test(raw)) throw bad(name, `${name}: ожидается целое число`);
  const n = Number(raw);
  if (n < min || n > max) throw bad(name, `${name}: от ${min} до ${max}`);
  return n;
}

/** runtime.yaml#data_api.query_params */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const filter: FilterCond[] = [];
  for (const [key, value] of params) {
    if (!key.startsWith("filter[")) continue;
    const m = FILTER_RE.exec(key);
    if (!m) throw bad(key, "Неверный фильтр");
    const op = (m[2] ?? "eq") as FilterOp;
    if (!OPS.has(op)) throw bad(m[1] as string, `Неизвестная операция ${op}`);
    filter.push({
      field: m[1] as string,
      op,
      value: value === "null" && (op === "eq" || op === "ne") ? null : op === "in" ? value.split(",") : value,
    });
  }
  const sort: SortKey[] = [];
  const rawSort = params.get("sort");
  if (rawSort) {
    const parts = rawSort.split(",").filter(Boolean);
    if (parts.length > 3) throw bad("sort", "Не больше 3 полей сортировки");
    for (const p of parts) {
      const desc = p.startsWith("-");
      const field = desc ? p.slice(1) : p;
      if (!/^[a-z_][a-z0-9_]*$/.test(field)) throw bad("sort", "Неверное поле сортировки");
      sort.push({ field, dir: desc ? "desc" : "asc" });
    }
  }
  const search = (params.get("q") ?? "").trim();
  if (search.length > SEARCH_MAX) throw bad("q", `q: не длиннее ${SEARCH_MAX} символов`);
  return {
    filter,
    sort,
    page: intParam(params.get("page"), "page", 1, 1, 1_000_000),
    limit: intParam(params.get("limit"), "limit", 20, 1, 100),
    ...(search ? { search } : {}),
  };
}

/** JSON body ≤ 1 MiB (runtime.yaml#data_api.writes). */
export async function readJsonBody(c: RuntimeContext): Promise<unknown> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new WizardError("PAYLOAD_TOO_LARGE");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) throw new WizardError("PAYLOAD_TOO_LARGE");
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new WizardError("VALIDATION_FAILED", { message: "Тело запроса — не JSON" });
  }
}

export function dataRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  const data = (c: RuntimeContext) => c.get("system").data;

  app.get("/:entity", async (c) => {
    const q = parseListQuery(new URL(c.req.url).searchParams);
    return c.json(await data(c).list(await subjectOf(c), c.req.param("entity"), q));
  });
  app.post("/:entity", async (c) => {
    const subject = await subjectOf(c);
    const body = await readJsonBody(c);
    const ipHmac = c.get("services").ipHmac?.(c.req.raw) ?? null;
    return c.json({ item: await data(c).create(subject, c.req.param("entity"), body, { ipHmac }) }, 201);
  });
  app.get("/:entity/:id", async (c) => {
    const entity = c.req.param("entity");
    const id = c.req.param("id");
    const item = await data(c).get(await subjectOf(c), entity, id);
    // M3-02: record meta `_aiFilled` (RecordCard «заполнено ИИ») for entities that AI actions fill.
    const targets = aiTargetFields(c.get("system").spec, entity);
    if (targets.size === 0) return c.json({ item });
    const marked = await aiFilledFields(c.get("system"), entity, id, targets);
    return c.json({ item: { ...item, _aiFilled: marked.filter((f) => f in item) } });
  });
  app.patch("/:entity/:id", async (c) => {
    const subject = await subjectOf(c);
    const body = await readJsonBody(c);
    const ipHmac = c.get("services").ipHmac?.(c.req.raw) ?? null;
    const id = c.req.param("id");
    return c.json({ item: await data(c).update(subject, c.req.param("entity"), id, body, { ipHmac }) });
  });
  app.delete("/:entity/:id", async (c) => {
    await data(c).remove(await subjectOf(c), c.req.param("entity"), c.req.param("id"));
    return c.body(null, 204);
  });
  return app;
}
