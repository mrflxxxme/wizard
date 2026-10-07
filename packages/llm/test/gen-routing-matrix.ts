// Generates test/routing.matrix.json (data-boundary.yaml#tests[0]): the expected tier/route_reason for
// callType × ruOnly × t1Restricted × payload × containsPiiHint × build default tier, written straight from
// models.yaml#routing_algorithm on abstract payload classes (independent of src/policy.ts).
// Run: node packages/llm/test/gen-routing-matrix.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MATRIX_PATH = join(dirname(fileURLToPath(import.meta.url)), "routing.matrix.json");

export const CALL_TYPES = [
  "interview",
  "card",
  "plan",
  "system_plan",
  "build_texts",
  "build_design",
  "build_custom",
  "build_ops",
  "build_code",
  "fix",
  "qa_generate",
  "qa_explain",
  "audit",
  "import_mapping",
  "runtime_ai_extract",
  "runtime_ai_generate",
  "support",
] as const;

/** Real texts per payload class; the router sees these through @wizard/pii.detect. */
export const PAYLOADS = {
  none: "Нужна система регистрации на отраслевой форум с типами билетов и оплатой.",
  basic: "Контакт организатора: Иван Петров, телефон +7 916 123-45-67.",
  strong: "Паспорт участника 4510 123456, СНИЛС 112-233-445 95.",
  special: "Иван Петров, диагноз — сахарный диабет, нужна отметка о диете.",
} as const;
export type Payload = keyof typeof PAYLOADS;

const ALWAYS_T0 = new Set(["runtime_ai_extract", "runtime_ai_generate", "support"]);
const DEFAULT_T0 = new Set(["audit", "runtime_ai_extract", "runtime_ai_generate", "support"]);

export const COLUMNS = [
  "callType",
  "ruOnly",
  "t1Restricted",
  "payload",
  "hint",
  "buildTier",
  "tier",
  "reason",
] as const;
type Hint = boolean | "absent";
type Restricted = boolean | "absent";
export type Row = [string, boolean, Restricted, Payload, Hint, "T1" | "T0", "T0" | "T1", string];

function expected(
  ct: string,
  ruOnly: boolean,
  restricted: Restricted,
  payload: Payload,
  hint: Hint,
  build: "T1" | "T0",
): [string, string] {
  if (ruOnly) return ["T0", "policy_ru_only"];
  if (restricted !== false) return ["T0", "policy_region_restricted"];
  if (ALWAYS_T0.has(ct)) return ["T0", "callType_forbidden_T1"];
  if (ct === "import_mapping" && !(hint === false && payload === "none"))
    return ["T0", "callType_forbidden_T1"];
  if (hint === true) return ["T0", "pii_hint"];
  if (payload === "strong" || payload === "special") return ["T0", "pii_high_risk"];
  if (ct === "interview" && payload !== "none") return ["T0", "pii_detected_interview"];
  if (DEFAULT_T0.has(ct) || build === "T0") return ["T0", "default_T0"];
  return ["T1", "default_T1"];
}

export function buildMatrix(): { columns: typeof COLUMNS; rows: Row[] } {
  const rows: Row[] = [];
  for (const ct of CALL_TYPES)
    for (const ruOnly of [true, false])
      for (const restricted of [true, false, "absent"] as Restricted[])
        for (const payload of Object.keys(PAYLOADS) as Payload[])
          for (const hint of ["absent", false, true] as Hint[])
            for (const build of ["T1", "T0"] as const) {
              const [tier, reason] = expected(ct, ruOnly, restricted, payload, hint, build);
              rows.push([ct, ruOnly, restricted, payload, hint, build, tier as "T0" | "T1", reason]);
            }
  return { columns: COLUMNS, rows };
}

export function serialize(m: ReturnType<typeof buildMatrix>): string {
  // Same layout as `biome format`, so regenerating does not break `pnpm lint`.
  const arr = (xs: readonly unknown[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  const rows = m.rows.map((r) => `    ${arr(r)}`).join(",\n");
  return `{\n  "columns": ${arr(m.columns)},\n  "rows": [\n${rows}\n  ]\n}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(MATRIX_PATH, serialize(buildMatrix()));
  process.stdout.write(`wrote ${MATRIX_PATH}\n`);
}
