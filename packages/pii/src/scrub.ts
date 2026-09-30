// scrub(): one-way placeholders (data-boundary.yaml#scrub). The value→placeholder numbering lives only in a local
// closure for the duration of ONE call and is never returned, logged or stored.
import { detect } from "./detect.js";
import { normalizePhoneRu } from "./detectors/phone.js";
import { type Category, type Finding, KIND_INFO, type Kind, maxCategory } from "./types.js";
import { fold, onlyDigits } from "./util.js";

export interface ScrubSummary {
  /** Number of findings per kind (special/biometric context included, though not replaced). */
  counts: Partial<Record<Kind, number>>;
  maxCategory: Category;
  /** A strong identifier (card, passport, SNILS, personal INN, personal account) was found. */
  strongIds: boolean;
}

export interface ScrubResult extends ScrubSummary {
  text: string;
}

export interface ScrubJsonResult<T> extends ScrubSummary {
  value: T;
}

export interface ScrubMessagesResult<T> extends ScrubSummary {
  messages: T[];
}

function valueKey(kind: Kind, raw: string): string {
  switch (kind) {
    case "phone_ru":
      return normalizePhoneRu(raw) ?? onlyDigits(raw);
    case "card":
    case "passport_ru":
    case "snils":
    case "inn_person":
    case "account_ru":
    case "birthdate":
      return onlyDigits(raw) || fold(raw);
    default:
      return fold(raw).replace(/[\s.,]+/g, " ").trim();
  }
}

interface Scrubber {
  string(text: string): string;
  summary(): ScrubSummary;
}

function createScrubber(): Scrubber {
  // Local only: numbering of distinct values per kind within this call.
  const seen = new Map<string, number>();
  const next = new Map<Kind, number>();
  const counts: Partial<Record<Kind, number>> = {};
  let category: Category = "none";
  let strongIds = false;

  const placeholder = (f: Finding, raw: string): string | null => {
    const stem = KIND_INFO[f.kind].placeholder;
    if (!stem) return null;
    const key = `${f.kind}\u0000${valueKey(f.kind, raw)}`;
    let n = seen.get(key);
    if (n === undefined) {
      n = (next.get(f.kind) ?? 0) + 1;
      next.set(f.kind, n);
      seen.set(key, n);
    }
    return `[${stem}_${n}]`;
  };

  return {
    string(text: string): string {
      const findings = detect(text);
      if (findings.length === 0) return text;
      let out = "";
      let pos = 0;
      for (const f of findings) {
        counts[f.kind] = (counts[f.kind] ?? 0) + 1;
        category = maxCategory(category, f.category);
        if (KIND_INFO[f.kind].strong) strongIds = true;
        const ph = placeholder(f, text.slice(f.start, f.end));
        if (ph === null || f.start < pos) continue;
        out += text.slice(pos, f.start) + ph;
        pos = f.end;
      }
      return out + text.slice(pos);
    },
    summary: () => ({ counts: { ...counts }, maxCategory: category, strongIds }),
  };
}

/** Replaces personal data with `[ВИД_n]` placeholders. Returns no mapping (MUST, M0-05). */
export function scrub(text: string): ScrubResult {
  const s = createScrubber();
  const out = s.string(text);
  return { text: out, ...s.summary() };
}

// Integers long enough to be a phone/ID are scanned too (a phone stored as a JSON number).
const LONG_INTEGER = 1_000_000_000;

function walk(value: unknown, s: Scrubber, skipKeys: ReadonlySet<string>): unknown {
  if (typeof value === "string") return s.string(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value) || Math.abs(value) < LONG_INTEGER) return value;
    const str = String(value);
    const out = s.string(str);
    return out === str ? value : out;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, s, skipKeys));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[s.string(k)] = skipKeys.has(k) ? v : walk(v, s, skipKeys);
    }
    return out;
  }
  return value;
}

/** Scrubs every string (and object key) of a JSON value with ONE numbering (data-boundary.yaml#detectors.interface.scrubJson). */
export function scrubJson<T>(value: T): ScrubJsonResult<T> {
  const s = createScrubber();
  const out = walk(value, s, new Set()) as T;
  return { value: out, ...s.summary() };
}

// Structural fields of chat messages that never carry user text.
const MESSAGE_SKIP_KEYS: ReadonlySet<string> = new Set(["role", "type", "id", "tool_call_id", "tool_use_id"]);

/** Scrubs a chat message array (OpenAI-compatible shape or any JSON) with one numbering across all messages. */
export function scrubMessages<T>(messages: readonly T[]): ScrubMessagesResult<T> {
  const s = createScrubber();
  const out = messages.map((m) => walk(m, s, MESSAGE_SKIP_KEYS) as T);
  return { messages: out, ...s.summary() };
}
