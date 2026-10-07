// Tolerant JSON reading of model answers (B2-41): arguments that came as text — fenced in ```json, with a lead-in
// sentence, trailing commas, or cut off by the token limit. Deterministic and local; nothing here calls a model.

const parse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const CLOSER: Record<string, string> = { "{": "}", "[": "]" };

/** Trailing commas before a closing bracket, outside strings. */
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      const rest = text.slice(i + 1).trimStart();
      if (rest.startsWith("}") || rest.startsWith("]")) continue;
    }
    out += c;
  }
  return out;
}

/**
 * Cut-off JSON closed at the last complete value: the text before a comma (or after a closing bracket) outside strings,
 * plus the brackets still open there. Tried from the end; null when no cut parses.
 */
function closeTruncated(text: string, maxTries = 60): unknown | null {
  const cuts: { at: number; open: string[] }[] = [];
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      cuts.push({ at: i + 1, open: [...stack] });
    } else if (c === ",") cuts.push({ at: i, open: [...stack] });
  }
  for (let k = cuts.length - 1, n = 0; k >= 0 && n < maxTries; k--, n++) {
    const cut = cuts[k] as { at: number; open: string[] };
    const closers = cut.open
      .slice()
      .reverse()
      .map((b) => CLOSER[b])
      .join("");
    const r = parse(dropTrailingCommas(text.slice(0, cut.at) + closers));
    if (r.ok && r.value !== null && typeof r.value === "object") return r.value;
  }
  return null;
}

/**
 * The JSON object or array in a model text: plain, fenced, after a lead-in, with trailing commas or cut off at the end.
 * undefined when there is none.
 */
export function looseJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)(?:```|$)/i.exec(t);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.search(/[{[]/);
  if (start < 0) return undefined;
  t = t.slice(start);
  const whole = parse(t);
  if (whole.ok) return whole.value;
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (end > 0) {
    const r = parse(dropTrailingCommas(t.slice(0, end + 1)));
    if (r.ok) return r.value;
  }
  return closeTruncated(t) ?? undefined;
}

/** A tool's arguments from a string (raw invalid JSON of the provider, or a JSON text answer); else undefined. */
export function looseObject(v: unknown): Record<string, unknown> | undefined {
  const x = typeof v === "string" ? looseJson(v) : v;
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;
}
