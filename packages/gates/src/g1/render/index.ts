// G1-RENDER-01 (gates.yaml#G1): every page renders with react-dom/server for each of its roles on the seed. Data
// comes from the real runtime as that role (SDK client over G1Env); the page code runs in render/child.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSpec, USERS_ENTITY } from "@wizard/appspec";
import type { Finding } from "../../report.js";
import type { Actor, G1Env } from "../env.js";
import { fieldPiiCategory } from "../seed.js";
import type { Seed } from "../types.js";
import { buildRenderBundle } from "./bundle.js";
import { type GuestFetch, RenderProcess } from "./host.js";
import { formsWithoutConsent, isBlank, parseHtml, wzProblems } from "./html.js";

/** Per page × role ceiling (data round trips included). */
export const RENDER_TIMEOUT_MS = 10_000;

export type RenderOutcomeCheck =
  | { kind: "findings"; findings: Finding[] }
  | { kind: "error"; reason_ru: string; evidence?: string };

export interface RenderContext {
  env: G1Env;
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  seed: Seed;
  actors: Map<string, Actor[]>;
  /** Milliseconds left of the G1 budget. */
  timeLeft: () => number;
  /** Writable folder for the bundle (the only one the render process may read). */
  workDir: string;
  /** Ceiling per page × role (default RENDER_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Observer of every finished render (tests). */
  onRender?: (r: { file: string; role: string; path: string; html?: string; passes?: number }) => void;
}

const enc = encodeURIComponent;
const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Entity a route param points to: <entity>Id / <entity>_id, the preceding segment, or what the page loads. */
function paramEntity(spec: AppSpec, route: string, param: string, source: string): string | null {
  const names = new Set(spec.entities.map((e) => e.name));
  const byParam = camelToSnake(param).replace(/_id$/, "");
  if (param !== "id" && names.has(byParam)) return byParam;
  const segs = route.split("/").filter(Boolean);
  const prev = segs[segs.indexOf(`:${param}`) - 1];
  if (prev && !prev.startsWith(":")) {
    const s = prev.replace(/-/g, "_");
    for (const cand of [s, s.replace(/s$/, ""), s.replace(/es$/, "")]) if (names.has(cand)) return cand;
  }
  const used =
    /\buse(?:Entity|Record)\(\s*["']([a-z][a-z0-9_]*)["']/.exec(source) ??
    /\bentity=["']([a-z][a-z0-9_]*)["']/.exec(source);
  if (used?.[1] && (names.has(used[1]) || used[1] === USERS_ENTITY)) return used[1];
  return null;
}

/** Route with params filled from rows the actor can read (data API as the role), else from the seed. */
async function routePath(ctx: RenderContext, route: string, file: string, actor: Actor): Promise<string> {
  const params = route.split("/").filter((s) => s.startsWith(":"));
  let path = route;
  for (const p of params) {
    const name = p.slice(1);
    const entity = paramEntity(ctx.spec, route, name, ctx.files.get(file) ?? "");
    let id: string | null = null;
    if (entity === USERS_ENTITY) id = actor.id;
    else if (entity) {
      const r = await ctx.env.request(actor, "GET", `/api/data/${enc(entity)}?limit=1`);
      const first = (r.body as { items?: { id?: unknown }[] } | null)?.items?.[0]?.id;
      id =
        typeof first === "string" ? first : ((ctx.seed.rows[entity]?.[0]?.id as string | undefined) ?? null);
    }
    path = path.replace(p, enc(id ?? "1"));
  }
  return path;
}

/** pii≠none fields of entities the role may create or update (consent is required from non-admin roles). */
function writablePii(spec: AppSpec, role: string): Set<string> {
  const out = new Set<string>();
  if (spec.roles.find((r) => r.name === role)?.isAdmin) return out;
  for (const p of spec.permissions) {
    if (p.role !== role || !p.ops.some((op) => op === "create" || op === "update")) continue;
    const e = spec.entities.find((x) => x.name === p.entity);
    for (const f of e?.fields ?? []) if (fieldPiiCategory(f) !== "none") out.add(f.name);
  }
  return out;
}

/**
 * Only reads leave the render: GET of the runtime API and POST of queries (useQuery). The event stream never ends,
 * so it is refused like writes.
 */
function allowed(spec: AppSpec, req: GuestFetch): boolean {
  if (!req.path.startsWith("/") || req.path.startsWith("//")) return false;
  if (req.method === "GET") return /^\/(api|_wizard)\//.test(req.path) && !/^\/api\/events\b/.test(req.path);
  const fn = /^\/api\/fn\/([A-Za-z0-9_]+)$/.exec(req.path);
  return req.method === "POST" && !!fn && spec.functions?.find((f) => f.name === fn[1])?.kind === "query";
}

export async function renderPages(ctx: RenderContext): Promise<RenderOutcomeCheck> {
  const { spec, env } = ctx;
  const pages = spec.pages ?? [];
  if (pages.length === 0) return { kind: "findings", findings: [] };
  if (env.runtime.env?.unsafeLocalExec !== true)
    return {
      kind: "error",
      reason_ru:
        "страницы не отрисованы: выполнение кода системы отключено (нужен WIZARD_UNSAFE_LOCAL_EXEC=1)",
    };
  const bundle = await buildRenderBundle(spec, ctx.files);
  if (!bundle.ok)
    return {
      kind: "error",
      reason_ru: "страницы не собираются для отрисовки",
      evidence: bundle.errors.slice(0, 5).join("; "),
    };
  const dir = join(ctx.workDir, "render");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "render.js"), bundle.code);

  let current: Actor = env.anonymous();
  const proc = new RenderProcess(dir, async (req) => {
    if (!allowed(spec, req))
      return {
        status: 403,
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "render: read only" } }),
      };
    const r = await env.raw(current, req.method, req.path, req.body ?? undefined);
    return { status: r.status, body: r.text };
  });
  const routes = pages.map((p) => p.route);
  const roleSpecs = new Map<string, unknown>();
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (key: string, f: Finding) => {
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  try {
    for (const [i, page] of pages.entries()) {
      for (const role of page.roles) {
        const actor = ctx.actors.get(role)?.[0];
        if (!actor) continue;
        const left = ctx.timeLeft();
        if (left <= 0) return { kind: "error", reason_ru: "превышено время G1 (120 с)" };
        current = actor;
        if (!roleSpecs.has(role))
          roleSpecs.set(role, (await env.request(actor, "GET", "/_wizard/spec")).body);
        const path = await routePath(ctx, page.route, page.file, actor);
        const where = { file: page.file, path: `/pages/${i}` };
        const name = `«${page.title}» (${page.route}) для роли ${role}`;
        const limit = Math.min(ctx.timeoutMs ?? RENDER_TIMEOUT_MS, left);
        const out = await proc.render(
          { file: page.file, path, routes, roleSpec: roleSpecs.get(role) ?? null },
          limit,
        );
        ctx.onRender?.({
          file: page.file,
          role,
          path,
          ...(out.kind === "done" && out.html !== undefined ? { html: out.html } : {}),
          ...(out.kind === "done" && out.passes !== undefined ? { passes: out.passes } : {}),
        });
        if (out.kind === "timeout" && limit < (ctx.timeoutMs ?? RENDER_TIMEOUT_MS))
          return { kind: "error", reason_ru: "превышено время G1 (120 с)" };
        if (out.kind !== "done") {
          add(`${i}:${role}:proc`, {
            ...where,
            message_ru: `Страница ${name} не отрисовалась`,
            evidence:
              out.kind === "timeout"
                ? `отрисовка дольше ${Math.max(1, Math.round(limit / 1000))} с`
                : out.message,
            fixHint: `Проверьте ${page.file}: бесконечный цикл или тяжёлые вычисления при отрисовке`,
          });
          continue;
        }
        const errors = out.logs.filter((l) => l.level === "error");
        if (errors.length)
          add(`${i}:${role}:console`, {
            ...where,
            message_ru: `Страница ${name} пишет ошибки в консоль`,
            evidence: errors
              .slice(0, 3)
              .map((l) => l.text)
              .join(" | "),
            fixHint: `Исправьте ${page.file}: при отрисовке не должно быть ошибок в консоли`,
          });
        if (!out.ok || out.html === undefined) {
          add(`${i}:${role}:throw`, {
            ...where,
            message_ru: `Страница ${name} падает при отрисовке`,
            evidence: out.error ?? "нет HTML",
            fixHint: `Исправьте ${page.file}: страница должна отрисовываться и пока данные загружаются (data === undefined), и на данных seed`,
          });
          continue;
        }
        const root = parseHtml(out.html);
        if (isBlank(root))
          add(`${i}:${role}:blank`, {
            ...where,
            message_ru: `Страница ${name} пустая`,
            fixHint: `Проверьте ${page.file}: страница должна показывать содержимое, пустое состояние или ошибку`,
          });
        for (const w of wzProblems(root, bundle.wzMap))
          add(`${i}:wz:${w.component}`, {
            ...where,
            message_ru: `На странице «${page.title}» компонент ${w.component} без отметки data-wz-id`,
            evidence: `data-wz-id=${w.wzId ?? "нет"}`,
            fixHint:
              "Используйте компоненты @wizard/ui-kit прямо в JSX страницы (<Button …/>), без переприсваивания в переменные",
          });
        for (const fields of formsWithoutConsent(root, writablePii(spec, role)))
          add(`${i}:${role}:consent:${fields.join(",")}`, {
            ...where,
            message_ru: `Форма на странице ${name} собирает персональные данные (${fields.join(", ")}) без согласия на обработку`,
            fixHint: "Добавьте в форму ConsentCheckbox из @wizard/ui-kit или используйте RecordForm",
          });
      }
    }
  } finally {
    proc.kill();
  }
  return { kind: "findings", findings };
}
