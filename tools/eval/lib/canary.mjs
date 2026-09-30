// pii_leaks (specs/quality/eval.yaml#metrics.pii_leaks), independent of packages/pii:
// (a) exact occurrences of the brief's canary values and their normalized form (lower case; phone digits without
//     separators) in outbound T1 payloads; (b) T1 requests whose callType is in pii_forbidden_for_T1.always.
// Payloads are inspected in memory and never stored.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlFiles } from "../../specs/validate.mjs";

const MODELS_YAML = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "specs",
  "agents",
  "models.yaml",
);

/** specs/agents/models.yaml#pii_forbidden_for_T1.always, read from the spec (not from @wizard/llm). */
export function loadForbiddenForT1(path = MODELS_YAML) {
  const r = parseYamlFiles([path])[path];
  if (!r || r.error !== undefined) throw new Error(`не удалось прочитать ${path}: ${r?.error}`);
  const always = r.ok?.pii_forbidden_for_T1?.always;
  if (!Array.isArray(always) || !always.length)
    throw new Error("models.yaml: нет pii_forbidden_for_T1.always");
  return always.map(String);
}

const PHONE = /^\+?[\d\s().-]+$/;

/** One matcher per canary: phones match with or without separators, the rest case-insensitively. */
export function canaryMatchers(canaries = []) {
  return canaries.map((value) => {
    const digits = value.replace(/\D/g, "");
    if (PHONE.test(value) && digits.length >= 7) {
      return { value, kind: "phone", re: new RegExp(digits.split("").join("[\\s().-]*"), "g") };
    }
    const esc = value
      .toLowerCase()
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    return { value, kind: value.startsWith("@") ? "handle" : "text", re: new RegExp(esc, "gu") };
  });
}

/** Occurrences of all canaries in one payload (string or JSON-serializable). */
export function countCanaries(payload, matchers) {
  const text = (typeof payload === "string" ? payload : (JSON.stringify(payload) ?? "")).toLowerCase();
  let n = 0;
  for (const m of matchers) n += text.match(m.re)?.length ?? 0;
  return n;
}

/**
 * Leak meter of one run. inspectT1(payload) counts canaries in a T1 payload (nothing is kept);
 * recordT1Call(callType) counts a T1 request of a pii_forbidden_for_T1.always call type.
 * @param {{canaries?: string[], forbiddenForT1?: string[]}} [o]
 */
export function createLeakMeter({ canaries = [], forbiddenForT1 = [] } = {}) {
  const matchers = canaryMatchers(canaries);
  const forbidden = new Set(forbiddenForT1);
  const state = { canaryHits: 0, forbiddenCalls: 0, t1Payloads: 0 };
  return {
    inspectT1(payload) {
      state.t1Payloads += 1;
      state.canaryHits += countCanaries(payload, matchers);
    },
    recordT1Call(callType) {
      if (forbidden.has(callType)) state.forbiddenCalls += 1;
    },
    get leaks() {
      return state.canaryHits + state.forbiddenCalls;
    },
    snapshot() {
      return { pii_leaks: state.canaryHits + state.forbiddenCalls, ...state };
    },
  };
}
