// Fixes of the techreview the harness applies by code (V3-15): a function patch only in functions/custom/** (a function
// of the spec, not a module file) re-checked by the G0 code checks and the whole deterministic part; an extension
// operation (C5) checked by applyExtensions (RLS, ПДн and migration rules) and the deterministic part. A fix that adds
// a blocker is reverted; the finding stays open with the reason.
import {
  type AppSpec,
  applyExtensions,
  CUSTOM_FUNCTIONS_DIR,
  EXTENSION_SOURCE_LIMIT,
  type ExtensionOp,
  extensionOpSchema,
} from "@wizard/appspec";
import { checkCode } from "@wizard/gates";
import { blockingChecks } from "./checks.js";
import type { FixOutcome, ReviewFinding, TechCheck, TechSystem } from "./types.js";

export interface FixResult {
  outcome: FixOutcome;
  /** The system with the fix (applied only). */
  system?: TechSystem;
  /** Deterministic checks of that system. */
  checks?: TechCheck[];
  /** The accepted extension operation. */
  extension?: ExtensionOp;
  /** The finding is closed: the fix applied and its evidence check (if any) no longer fails. */
  closed: boolean;
  /** An extension that passed the checks but the host does not merge extensions: a «Запрос на развитие». */
  deferred?: boolean;
}

const key = (c: TechCheck) => `${c.id}|${c.ref ?? ""}|${c.message_ru}`;

/** Blockers of `after` that `before` did not have. */
export function newBlockers(before: readonly TechCheck[], after: readonly TechCheck[]): TechCheck[] {
  const was = new Set(blockingChecks(before).map(key));
  return blockingChecks(after).filter((c) => !was.has(key(c)));
}

/** Why a function patch is not allowed here (null — allowed). */
export function patchRefusal(spec: AppSpec, files: ReadonlyMap<string, string>, file: string): string | null {
  if (!file.startsWith(CUSTOM_FUNCTIONS_DIR))
    return `правка только в ${CUSTOM_FUNCTIONS_DIR}** — функции модулей не меняются`;
  if (!files.has(file)) return `файла ${file} в системе нет — техревью правит, а не добавляет функции`;
  if (!(spec.functions ?? []).some((f) => f.file === file))
    return `файл ${file} не объявлен функцией системы`;
  return null;
}

/** Applies one fix of a finding to `system` (round `round`); `recheck` is the deterministic part. */
export async function applyFix(
  f: ReviewFinding,
  o: {
    system: TechSystem;
    checks: readonly TechCheck[];
    round: number;
    recheck: (system: TechSystem) => Promise<TechCheck[]>;
    /** The host merges extension operations into the spec. */
    applyExtensions: boolean;
  },
): Promise<FixResult> {
  const fix = f.fix;
  if (fix.kind === "none")
    return {
      outcome: {
        finding: f.id,
        kind: "function_patch",
        round: o.round,
        applied: false,
        reason_ru: "нет исправления",
      },
      closed: false,
    };
  const refused = (reason_ru: string): FixResult => ({
    outcome: { finding: f.id, kind: fix.kind, round: o.round, applied: false, reason_ru },
    closed: false,
  });

  let candidate: TechSystem;
  let extension: ExtensionOp | undefined;
  if (fix.kind === "function_patch") {
    const why = patchRefusal(o.system.spec, o.system.files, fix.file);
    if (why) return refused(why);
    if (fix.source.length > EXTENSION_SOURCE_LIMIT) return refused("слишком большой файл функции");
    const files = new Map(o.system.files).set(fix.file, fix.source);
    const code = await checkCode({ spec: o.system.spec, files, file: fix.file });
    if (code.length) return refused(`код не прошёл проверки G0: ${code[0]?.message_ru ?? code[0]?.id}`);
    candidate = { spec: o.system.spec, files };
  } else {
    const parsed = extensionOpSchema.safeParse(fix.op);
    const r = applyExtensions(o.system.spec, [fix.op], { files: Object.fromEntries(o.system.files) });
    const rejected = r.rejected[0];
    if (rejected || !parsed.success) return refused(rejected?.reasonRu ?? "операция не по схеме расширения");
    extension = parsed.data;
    candidate = { spec: r.spec, files: new Map([...o.system.files, ...Object.entries(r.files)]) };
  }

  const checks = await o.recheck(candidate);
  const added = newBlockers(o.checks, checks);
  if (added.length) return refused(`исправление ломает проверку ${added[0]?.id}: ${added[0]?.message_ru}`);
  if (fix.kind === "extension" && !o.applyExtensions)
    return {
      ...refused(
        "доработка схемы прошла проверки, но эта сборка применяет только правки функций — она записана в «Запросы на развитие»",
      ),
      deferred: true,
    };
  const evidence = f.evidence.kind === "check" ? checks.find((c) => c.id === f.evidence.ref) : undefined;
  const closed = evidence?.status !== "fail";
  return {
    outcome: { finding: f.id, kind: fix.kind, round: o.round, applied: true },
    system: candidate,
    checks,
    ...(extension ? { extension } : {}),
    closed,
  };
}
