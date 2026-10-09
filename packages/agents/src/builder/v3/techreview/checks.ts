// The deterministic part of the techreview (V3-15) — the source of truth the reviewer reads and the fixes are re-checked
// against: build and types, the migration dry run, RLS and ПДн (G0 and the static G2 on the system as it is, not
// committed yet), contract tests of the integrations (the V3-20 seam), the end-to-end chains between modules
// (chains.ts), basic performance and accessibility of the pages and functions. No model, no client data.
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import { planMigration, toDDL, toRLS } from "@wizard/appspec";
import {
  type Check,
  G0_CHECKS,
  G2_CHECKS,
  type GateContext,
  type GateReport,
  runG0,
  runG2,
} from "@wizard/gates";
import { OWNER_INPUT_CHECKS } from "../../v2/blockers.js";
import { chainChecks } from "./chains.js";
import {
  type IntegrationContractRunner,
  TECH_AREA_RU,
  type TechArea,
  type TechCheck,
  type TechGateLevel,
  type TechSystem,
} from "./types.js";

/** G2 checks without the runtime (the permission matrix G2-PERM-01…04 is the final gates stage). */
export const G2_STATIC_CHECKS: readonly string[] = G2_CHECKS.map((c) => c.id).filter(
  (id) => !/^G2-PERM-0[1-4]$/.test(id),
);
/** G0 checks without a database (G0-MIG-02 applies DDL and RLS to a shadow schema). */
export const G0_LOCAL_CHECKS: readonly string[] = G0_CHECKS.map((c) => c.id).filter(
  (id) => id !== "G0-MIG-02",
);

/** Schema name of the in-process dry run (never created). */
const DRY_SCHEMA = "app_techreview_dry";

/**
 * G0 and the static G2 in process, without a database: G0-MIG-02 is skipped (the migration is planned and its DDL and
 * RLS built by TR-MIG-01 instead). The checks run here never touch ctx.db (the same as gates' checkCode).
 */
export function localGates(level: TechGateLevel, system: TechSystem): Promise<GateReport> {
  const ctx: GateContext = {
    spec: system.spec,
    prevSpec: null,
    specVersion: 0,
    files: system.files,
    env: "draft",
    systemKey: "techreview",
    db: undefined as never,
  };
  return level === "G0" ? runG0(ctx, { only: G0_LOCAL_CHECKS }) : runG2(ctx, { only: G2_STATIC_CHECKS });
}

const AREA_BY_PREFIX: readonly [RegExp, TechArea][] = [
  [/^G0-MIG-/, "migrations"],
  [/^G0-SEC-/, "security"],
  [/^G0-A11Y-/, "accessibility"],
  [/^G0-/, "build"],
  [/^G2-(PII|TG)-/, "pii"],
  [/^G2-PERM-/, "permissions"],
  [/^G2-(SECRET|EGRESS)-/, "integrations"],
  [/^G2-/, "security"],
];

const areaOf = (id: string): TechArea => AREA_BY_PREFIX.find(([re]) => re.test(id))?.[1] ?? "build";

const clip = (s: string | undefined, n = 240) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Gate checks as techreview checks: blockers that fail a build (buildBlockers) stay blockers, the rest are warnings. */
export function fromGate(report: GateReport): TechCheck[] {
  return report.checks
    .filter((c) => c.id !== "G0" && c.id !== "G2")
    .map((c: Check): TechCheck => {
      const failed = c.status === "fail" || c.status === "error";
      const blocker =
        failed && c.severity === "blocker" && !(report.level === "G2" && OWNER_INPUT_CHECKS.has(c.id));
      const ref = c.path ?? (c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : undefined);
      const evidence = clip(c.evidence);
      return {
        id: c.id,
        area: areaOf(c.id),
        status: blocker
          ? "fail"
          : failed || c.status === "warn"
            ? "warn"
            : c.status === "skip"
              ? "skip"
              : "pass",
        severity: blocker ? "blocker" : "warning",
        message_ru: clip(c.message_ru, 400) ?? c.id,
        ...(evidence ? { evidence } : {}),
        ...(ref ? { ref } : {}),
      };
    });
}

/** TR-MIG-01: the migration from an empty schema is planned and its DDL and RLS build (no database at hand). */
export function migrationDryRun(spec: AppSpec): TechCheck {
  const base = { id: "TR-MIG-01", area: "migrations" as const };
  const plan = planMigration(null, spec, { env: "draft" });
  if (plan.errors.length)
    return {
      ...base,
      status: "fail",
      severity: "blocker",
      message_ru: `Миграция не строится: ${plan.errors
        .slice(0, 3)
        .map((e) => e.message_ru)
        .join("; ")}`,
    };
  try {
    const ddl = toDDL(plan, DRY_SCHEMA);
    toRLS(spec, DRY_SCHEMA);
    return {
      ...base,
      status: "pass",
      severity: "blocker",
      message_ru: `Пробный прогон миграции без базы: ${ddl.length} шагов DDL и политики строк строятся`,
    };
  } catch (e) {
    return {
      ...base,
      status: "fail",
      severity: "blocker",
      message_ru: "Миграция или политики строк не строятся",
      evidence: clip(String((e as Error)?.message ?? e)),
    };
  }
}

/** TR-RLS-01: every table of the system gets row level security (enabled and forced) from the permissions. */
export function rlsCoverage(spec: AppSpec): TechCheck {
  const base = { id: "TR-RLS-01", area: "rls" as const, severity: "blocker" as const };
  try {
    const sql = toRLS(spec, DRY_SCHEMA).join("\n");
    const bare = spec.entities.filter(
      (e) => !sql.includes(`ALTER TABLE "${DRY_SCHEMA}"."${e.name}" FORCE ROW LEVEL SECURITY`),
    );
    if (bare.length)
      return {
        ...base,
        status: "fail",
        message_ru: `Без политик строк: ${bare.map((e) => `«${e.label}»`).join(", ")}`,
      };
    return {
      ...base,
      status: "pass",
      message_ru: `Политики строк у всех ${spec.entities.length} сущностей, права ролей — из спеки`,
    };
  } catch (e) {
    return {
      ...base,
      status: "fail",
      message_ru: "Политики строк не строятся",
      evidence: clip(String((e as Error)?.message ?? e)),
    };
  }
}

/** Connectors of the platform's own channels: they go through the runtime outbox, G1 checks them in scenarios. */
const PLATFORM_CHANNELS = new Set(["email", "telegram"]);

/** TR-INT-<name>: contract tests of each integration (the V3-20 seam; without it — platform channels only). */
export async function integrationChecks(
  system: TechSystem,
  runner?: IntegrationContractRunner,
): Promise<TechCheck[]> {
  const out: TechCheck[] = [];
  for (const [i, integ] of (system.spec.integrations ?? []).entries()) {
    const base = { id: `TR-INT-${integ.name}`, area: "integrations" as const, ref: `/integrations/${i}` };
    if (PLATFORM_CHANNELS.has(integ.connector)) {
      out.push({
        ...base,
        status: "pass",
        severity: "warning",
        message_ru: `«${integ.name}» — канал платформы (${integ.connector}); письма и сообщения проверяют сценарии G1`,
      });
      continue;
    }
    const r = runner
      ? await runner(
          {
            name: integ.name,
            connector: integ.connector,
            config: (integ.config ?? {}) as Record<string, unknown>,
          },
          system,
        )
      : null;
    if (!r) {
      out.push({
        ...base,
        status: "skip",
        severity: "warning",
        message_ru: `Контрактных тестов для «${integ.name}» (${integ.connector}) пока нет — они появятся с харнессом интеграций`,
      });
      continue;
    }
    out.push({
      ...base,
      status: r.ok ? "pass" : "fail",
      severity: "blocker",
      message_ru: r.ok
        ? `«${integ.name}»: контрактные тесты прошли${r.mock ? " на моке (ключа ещё нет)" : ""}`
        : `«${integ.name}»: контрактные тесты не прошли — ${r.problems.slice(0, 3).join("; ")}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- performance and accessibility basics

/** Files of the public front and custom screens (their markup is the builder's, not the module cabinets'). */
const FRONT_RE = /^ui\/(pages|sections|patterns|custom)\/.+\.(tsx|jsx)$/;
/** A page file this big slows the first screen down. */
export const PAGE_SOURCE_WARN = 64 * 1024;
/** An inline image this big belongs in a file. */
export const INLINE_IMAGE_WARN = 8 * 1024;

interface Tag {
  attrs: string;
  /** Index of the "<". */
  at: number;
  /** Index after the closing ">". */
  end: number;
  selfClosing: boolean;
}

/** Opening tags `<name …>` of JSX source, braces and quotes inside attribute values skipped. */
export function openTags(src: string, name: string): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(`<${name}(?=[\\s/>])`, "g");
  for (const m of src.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    let i = start;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    const attrs = src.slice(start, i);
    out.push({ attrs, at: m.index ?? 0, end: i + 1, selfClosing: attrs.trimEnd().endsWith("/") });
  }
  return out;
}

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;
const hasAttr = (attrs: string, ...names: string[]) =>
  names.some((n) => new RegExp(`(^|\\s)${n}\\s*=`).test(attrs) || /\{\s*\.\.\./.test(attrs));

/** Places where a rule fires: "file:line". */
type Hits = string[];

function scan(files: ReadonlyMap<string, string>, rule: (src: string) => number[]): Hits {
  const hits: Hits = [];
  for (const [path, src] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!FRONT_RE.test(path)) continue;
    for (const at of rule(src)) hits.push(`${path}:${lineOf(src, at)}`);
  }
  return hits;
}

function summary(
  id: string,
  area: TechArea,
  hits: Hits,
  ok_ru: string,
  bad_ru: (n: number) => string,
): TechCheck {
  if (!hits.length) return { id, area, status: "pass", severity: "warning", message_ru: ok_ru };
  const more = hits.length > 3 ? ` и ещё ${hits.length - 3}` : "";
  return {
    id,
    area,
    status: "warn",
    severity: "warning",
    message_ru: `${bad_ru(hits.length)}: ${hits.slice(0, 3).join(", ")}${more}`,
    ref: hits[0] as string,
  };
}

/** Accessibility basics of the public pages and custom screens (warnings; G0-A11Y-01 is not wired yet). */
export function accessibilityChecks(files: ReadonlyMap<string, string>): TechCheck[] {
  const controls = (src: string) =>
    ["input", "textarea", "select"].flatMap((n) =>
      openTags(src, n)
        .filter((t) => !/type\s*=\s*["'](hidden|submit|button|reset)["']/.test(t.attrs))
        .filter((t) => !hasAttr(t.attrs, "aria-label", "aria-labelledby", "id"))
        .map((t) => t.at),
    );
  const emptyButtons = (src: string) =>
    openTags(src, "button")
      .filter((t) => !t.selfClosing && !hasAttr(t.attrs, "aria-label", "aria-labelledby", "title"))
      .filter((t) => {
        const close = src.indexOf("</button>", t.end);
        const inner = close < 0 ? "" : src.slice(t.end, close);
        return inner.replace(/<[^>]*>/g, "").trim() === "";
      })
      .map((t) => t.at);
  return [
    summary(
      "TR-A11Y-01",
      "accessibility",
      scan(files, (src) =>
        openTags(src, "img")
          .filter((t) => !hasAttr(t.attrs, "alt"))
          .map((t) => t.at),
      ),
      "У картинок есть alt",
      (n) => `Картинки без alt (${n})`,
    ),
    summary(
      "TR-A11Y-02",
      "accessibility",
      scan(files, controls),
      "У полей форм есть подписи",
      (n) => `Поля форм без подписи — aria-label или id для label (${n})`,
    ),
    summary(
      "TR-A11Y-03",
      "accessibility",
      scan(files, emptyButtons),
      "У кнопок есть текст",
      (n) => `Кнопки без текста и aria-label (${n})`,
    ),
    summary(
      "TR-A11Y-04",
      "accessibility",
      scan(files, (src) =>
        ["div", "span", "li"].flatMap((n) =>
          openTags(src, n)
            .filter((t) => hasAttr(t.attrs, "onClick") && !hasAttr(t.attrs, "role"))
            .map((t) => t.at),
        ),
      ),
      "Нажатия — только на кнопках и ссылках",
      (n) => `Нажатие на элементе без роли — недоступно с клавиатуры (${n})`,
    ),
    summary(
      "TR-A11Y-05",
      "accessibility",
      scan(files, (src) => [...src.matchAll(/tabIndex\s*=\s*\{?\s*["']?[1-9]/g)].map((m) => m.index ?? 0)),
      "Порядок фокуса естественный",
      (n) => `Положительный tabIndex ломает порядок фокуса (${n})`,
    ),
  ];
}

/** Basic performance: page size, inline images, images without size or lazy loading, unbounded public reads. */
export function performanceChecks(spec: AppSpec, files: ReadonlyMap<string, string>): TechCheck[] {
  const big: Hits = [];
  for (const [path, src] of files)
    if (FRONT_RE.test(path) && src.length > PAGE_SOURCE_WARN) big.push(`${path}:1`);
  const unbounded: Hits = [];
  for (const fn of spec.functions ?? []) {
    if (fn.kind !== "query" || fn.public !== true) continue;
    const src = files.get(fn.file) ?? "";
    for (const m of src.matchAll(/\.list\(\s*(\{[^)]*\})?\s*\)/g))
      if (!/\blimit\s*:/.test(m[1] ?? "")) unbounded.push(`${fn.file}:${lineOf(src, m.index ?? 0)}`);
  }
  return [
    summary(
      "TR-PERF-01",
      "performance",
      big.sort(),
      "Страницы компактные",
      (n) => `Страницы тяжелее ${PAGE_SOURCE_WARN / 1024} КБ кода (${n})`,
    ),
    summary(
      "TR-PERF-02",
      "performance",
      scan(files, (src) =>
        [...src.matchAll(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g)]
          .filter((m) => m[0].length > INLINE_IMAGE_WARN)
          .map((m) => m.index ?? 0),
      ),
      "Картинки не встроены в код",
      (n) => `Картинки встроены в код base64 — лучше отдельным файлом (${n})`,
    ),
    summary(
      "TR-PERF-03",
      "performance",
      scan(files, (src) =>
        openTags(src, "img")
          .filter(
            (t) => !hasAttr(t.attrs, "loading") && !(hasAttr(t.attrs, "width") && hasAttr(t.attrs, "height")),
          )
          .map((t) => t.at),
      ),
      "У картинок есть размеры или ленивая загрузка",
      (n) => `Картинки без размеров и loading="lazy" — страница прыгает при загрузке (${n})`,
    ),
    summary(
      "TR-PERF-04",
      "performance",
      unbounded,
      "Публичные запросы читают ограниченно",
      (n) => `Публичные запросы читают список без limit (${n})`,
    ),
  ];
}

/** The deterministic part over a system: G0, the static G2, migrations and RLS, integrations, chains, pages. */
export async function deterministicChecks(
  system: TechSystem,
  o: {
    plan: SystemPlan;
    reference: AppSpec | null;
    evidence: readonly GateReport[];
    gates: (level: TechGateLevel, system: TechSystem) => Promise<GateReport>;
    integrations?: IntegrationContractRunner;
  },
): Promise<TechCheck[]> {
  const g0 = fromGate(await o.gates("G0", system));
  const g2 = fromGate(await o.gates("G2", system));
  const shadow = g0.find((c) => c.id === "G0-MIG-02");
  return [
    ...g0,
    ...(shadow && shadow.status !== "skip" ? [] : [migrationDryRun(system.spec)]),
    rlsCoverage(system.spec),
    ...g2,
    ...(await integrationChecks(system, o.integrations)),
    ...chainChecks({
      plan: o.plan,
      spec: system.spec,
      files: system.files,
      reference: o.reference,
      evidence: o.evidence,
    }),
    ...performanceChecks(system.spec, system.files),
    ...accessibilityChecks(system.files),
  ];
}

/** Checks that keep the system from publication. */
export const blockingChecks = (checks: readonly TechCheck[]): TechCheck[] =>
  checks.filter((c) => c.status === "fail" && c.severity === "blocker");

/** A Russian blocker line: «<область>: <что не так>». */
export const blockerLine = (c: Pick<TechCheck, "area" | "message_ru">): string =>
  `${TECH_AREA_RU[c.area]}: ${c.message_ru.replace(/\.$/, "")}`;
