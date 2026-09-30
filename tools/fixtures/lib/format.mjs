// Fixture line format (specs/quality/eval.yaml#fixtures.line) and canonical request key (#fixtures.canonical_request).
// packages/llm (M0-06) MUST produce the same key; the algorithm is documented in docs/reviews/impl-notes/M0-21.md.
import { createHash } from "node:crypto";

export const FIXTURE_VERSION = 1;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

/** JSON with object keys sorted recursively (arrays keep their order). */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function trimLineEnds(v, placeholders) {
  if (typeof v === "string") {
    let s = v.replace(/[ \t]+$/gm, "");
    for (const [value, ph] of placeholders) if (value) s = s.split(value).join(ph);
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => trimLineEnds(x, placeholders));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = trimLineEnds(x, placeholders);
    return out;
  }
  return v;
}

/**
 * Canonical request string: sorted-key JSON of {callType, modelId, messages, tools[{name, schemaHash}], temperature,
 * max_tokens}; in string values trailing spaces of lines are removed and ctx.runId/ctx.systemId become <runId>/<systemId>;
 * then, over the serialized JSON, UUIDs → <uuid:N> (N from 1 in order of first appearance, case-insensitive) and
 * ISO dates/datetimes → <date>.
 */
export function canonicalRequest({ callType, modelId, request }, ctx = {}) {
  const placeholders = [
    [ctx.runId, "<runId>"],
    [ctx.systemId, "<systemId>"],
  ];
  const body = {
    callType,
    modelId,
    messages: trimLineEnds(request.messages ?? [], placeholders),
    tools: (request.tools ?? []).map((t) => ({ name: t.name, schemaHash: t.schemaHash })),
    temperature: request.params?.temperature,
    max_tokens: request.params?.max_tokens,
  };
  const uuids = new Map();
  return stableStringify(body)
    .replace(UUID_RE, (m) => {
      const k = m.toLowerCase();
      if (!uuids.has(k)) uuids.set(k, `<uuid:${uuids.size + 1}>`);
      return uuids.get(k);
    })
    .replace(ISO_DATE_RE, "<date>");
}

export function fixtureKey(line, ctx) {
  return createHash("sha256").update(canonicalRequest(line, ctx)).digest("hex");
}

/** models.yaml#call_policy.context_too_long: tokens ≈ characters / 3.2. */
export function estimateTokens(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(s.length / 3.2);
}
