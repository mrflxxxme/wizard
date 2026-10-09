// Access keys typed as text (V3-21; security/data-boundary.yaml#secret_window.interception): known key formats of
// providers, private key blocks, credentials in URLs and headers, «name = value» assignments, and high-entropy tokens
// next to the words «ключ», «токен», «token», «api», «secret», «пароль». The chat refuses a message with a finding and
// offers the key window instead; log lines mask findings. Pure TypeScript without dependencies (the browser imports it
// as @wizard/pii/secrets). A finding carries offsets only — never the value.

export type SecretKind =
  | "provider"
  | "private_key"
  | "credentials_url"
  | "url_param"
  | "auth_header"
  | "assigned"
  | "entropy";

export interface SecretFinding {
  kind: SecretKind;
  /** Known key format (openai, github, yookassa, telegram, …); null for generic findings. */
  provider: string | null;
  /** UTF-16 offsets of the value, end exclusive. */
  start: number;
  end: number;
}

export interface SecretDetectOptions {
  /**
   * chat (default): a message that is one bare high-entropy token counts as a key too. log: that rule is off (request
   * ids and hashes are whole log fields), every other rule stays.
   */
  context?: "chat" | "log";
}

/** What replaces a key in masked text. */
export const SECRET_MASK = "[КЛЮЧ_СКРЫТ]";

const TOKEN_CH = "A-Za-z0-9_\\-";
const B = `(?<![${TOKEN_CH}])`;
const E = `(?![${TOKEN_CH}])`;
const re = (body: string, flags = "g") => new RegExp(`${B}(?:${body})${E}`, flags);

/** Known formats: the prefix makes them keys whatever the words around. */
const PROVIDERS: readonly (readonly [string, RegExp])[] = [
  ["anthropic", re("sk-ant-[A-Za-z0-9_-]{20,}")],
  ["openai", re("sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}")],
  ["stripe", re("(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}")],
  ["github", re("gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}")],
  ["gitlab", re("glpat-[A-Za-z0-9_-]{20,}")],
  ["slack", re("xox[abprs]-[A-Za-z0-9-]{10,}")],
  ["aws", re("(?:AKIA|ASIA)[0-9A-Z]{16}")],
  ["google", re("AIza[0-9A-Za-z_-]{35}")],
  ["telegram", re("[0-9]{6,12}:[A-Za-z0-9_-]{35}")],
  ["yookassa", re("(?:live|test)_[A-Za-z0-9_-]{32,}")],
  [
    "yandex_cloud",
    re("AQVN[A-Za-z0-9_-]{30,}|t1\\.[A-Za-z0-9_-]{30,}\\.[A-Za-z0-9_-]{30,}|y[0-3]_[A-Za-z0-9_-]{40,}"),
  ],
  ["jwt", re("eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{16,}")],
  ["sendgrid", re("SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}")],
  ["npm", re("npm_[A-Za-z0-9]{36}")],
  ["huggingface", re("hf_[A-Za-z0-9]{30,}")],
  ["zai", re("[0-9a-f]{32}\\.[A-Za-z0-9]{16}")],
  // Bitrix24 incoming webhook: the address itself is the key (/rest/<user>/<code>/).
  ["bitrix24", /https?:\/\/[A-Za-z0-9.-]+\/rest\/[0-9]+\/[a-z0-9]{10,}\/?/g],
];

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// Value groups are read with the `d` flag (match indices): the value is not always at the end of the match.
const CREDENTIALS_URL = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]+:([^\s/@]{3,})@[^\s/]+/dgi;
const URL_PARAM =
  /[?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|key|password|passwd|signature|sig)=([^&\s#"'<>]{8,})/dgi;
const AUTH_HEADER = /\b(?:Bearer|Basic|Token|OAuth)\s+([A-Za-z0-9._~+/-]{16,}=*)/dg;
const ASSIGNED =
  /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|passwd|pwd|ключ|токен|пароль|секрет(?!ар))[a-zа-яё_-]*["'`]?\s*(?:[:=]|=>|—|-)(?!\/\/)\s*["'`]?([!-~]{8,})/dgiu;
/** Words that make a nearby high-entropy token a key (Latin ones as whole words of the camelCase-split text). */
const KEYWORD_RU = /ключ|токен|секрет(?!ар)|пароль|авторизац|вебхук/iu;
const KEYWORD_EN =
  /\b(?:api|keys?|tokens?|secrets?|bearer|auth\w*|credentials?|passw\w*|pwd|client ?id|webhooks?)\b/i;
const keywordNear = (s: string): boolean =>
  KEYWORD_RU.test(s) || KEYWORD_EN.test(s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "));
const TOKEN = new RegExp(`${B}[A-Za-z0-9_\\-+/=.:~]{20,}${E}`, "g");

const shannon = (s: string): number => {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
};

const classes = (s: string): number =>
  Number(/[a-z]/.test(s)) +
  Number(/[A-Z]/.test(s)) +
  Number(/[0-9]/.test(s)) +
  Number(/[^A-Za-z0-9]/.test(s));

/** Placeholders and references that look like keys but are not: secret://name, <api-key>, your_api_key, ***. */
function placeholder(v: string): boolean {
  const t = v.replace(/^["'`]+|["'`,.;)]+$/g, "");
  return (
    /^secret:\/\/[a-z0-9_/]+$/.test(t) ||
    /^<[^>]*>$|^\{\{?[^}]*\}\}?$|^\$\{?[A-Z0-9_]+\}?$|^%[A-Z0-9_]+%$/.test(t) ||
    /^(?:x+|\*+|•+|\.+|-+|_+)$/i.test(t) ||
    /^(?:your|my|ваш|test)[_-]?(?:api[_-]?)?(?:key|token|secret|ключ)/i.test(t) ||
    /^\[[А-ЯЁA-Z_]+(?:_\d+)?\]$/u.test(t)
  );
}

/** A path, a dotted name or an address — words of lowercase letters between separators. */
function wordy(v: string): boolean {
  if (v.includes("://") || v.includes("@")) return true;
  const parts = v.split(/[/.:]/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.filter((p) => /^[a-z]{2,}$/.test(p) || /^[a-z]+(?:[-_][a-z]+)+$/.test(p)).length >= 2;
}

/** An assigned value strong enough to be a key (not «пароль: от 8 символов» or «token: none»). */
function strongValue(v: string): boolean {
  const t = v.replace(/["'`,;)]+$/g, "");
  if (t.length < 8 || placeholder(t) || wordy(t)) return false;
  if (/^[0-9]+$/.test(t)) return t.length >= 16;
  return t.length >= 16 ? shannon(t) >= 3 : classes(t) >= 2 && shannon(t) >= 2.5;
}

/** A token of 20+ characters that looks random: letters and digits (or 32+ hex), entropy ≥ 3 bits per character. */
function randomToken(v: string): boolean {
  if (placeholder(v) || wordy(v)) return false;
  const hex = /^[0-9a-f]{32,}$/i.test(v);
  if (!hex && !(/[A-Za-z]/.test(v) && /[0-9]/.test(v))) return false;
  return shannon(v) >= 3;
}

/** Strong without context: 32+ characters, lower, upper and digits, entropy ≥ 4.2. */
const veryRandom = (v: string): boolean =>
  v.length >= 32 &&
  /[a-z]/.test(v) &&
  /[A-Z]/.test(v) &&
  /[0-9]/.test(v) &&
  !wordy(v) &&
  !placeholder(v) &&
  shannon(v) >= 4.2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function push(out: SecretFinding[], f: SecretFinding): void {
  if (f.end > f.start) out.push(f);
}

/** Every key-like value in `text` (offsets only), overlaps resolved: the earlier and then the longer span wins. */
export function detectSecrets(text: string, o: SecretDetectOptions = {}): SecretFinding[] {
  if (typeof text !== "string" || text.length < 8) return [];
  const raw: SecretFinding[] = [];
  for (const [provider, rx] of PROVIDERS)
    for (const m of text.matchAll(rx))
      if (!placeholder(m[0]) && /[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0]))
        push(raw, { kind: "provider", provider, start: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(PRIVATE_KEY))
    push(raw, { kind: "private_key", provider: null, start: m.index, end: m.index + m[0].length });
  const group = (kind: SecretKind, rx: RegExp, ok: (v: string) => boolean) => {
    for (const m of text.matchAll(rx)) {
      const at = m.indices?.[1];
      // A value ends at the first quote, bracket or separator (JSON, code, prose).
      const v = m[1]?.split(/["'`,;{}[\]<>)&]/)[0];
      if (!v || !at || !ok(v)) continue;
      push(raw, { kind, provider: null, start: at[0], end: at[0] + v.length });
    }
  };
  group("credentials_url", CREDENTIALS_URL, (v) => !placeholder(v));
  group("url_param", URL_PARAM, (v) => !placeholder(v) && v.length >= 8);
  group("auth_header", AUTH_HEADER, (v) => !placeholder(v) && randomToken(v.replace(/=+$/, "")));
  group("assigned", ASSIGNED, strongValue);
  const trimmed = text.trim();
  for (const m of text.matchAll(TOKEN)) {
    const v = m[0].replace(/[.:]+$/, "");
    const start = m.index;
    const end = start + v.length;
    let hit = false;
    if (veryRandom(v)) hit = true;
    else if (randomToken(v)) {
      const near = text.slice(Math.max(0, start - 48), start) + text.slice(end, end + 24);
      if (keywordNear(near)) hit = !UUID.test(v) || /ключ|токен|key|token|secret|секрет/iu.test(near);
      // A message that is one bare token: mixed case with digits (an order number in capitals is not a key), or 32+ hex.
      else if ((o.context ?? "chat") === "chat" && v === trimmed && !UUID.test(v))
        hit = (/^[0-9a-f]{32,}$/i.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v))) && shannon(v) >= 3.5;
    }
    if (hit) push(raw, { kind: "entropy", provider: null, start, end });
  }
  // A specific rule wins an overlap over the generic token; within one rank the longer span wins.
  raw.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const out: SecretFinding[] = [];
  for (const f of raw) if (!out.some((t) => f.start < t.end && t.start < f.end)) out.push({ ...f });
  return out.sort((a, b) => a.start - b.start);
}

const RANK: Record<SecretKind, number> = {
  provider: 0,
  private_key: 0,
  credentials_url: 1,
  url_param: 1,
  auth_header: 1,
  assigned: 2,
  entropy: 3,
};

/** Does `text` carry an access key? */
export function hasSecret(text: string, o: SecretDetectOptions = {}): boolean {
  return detectSecrets(text, o).length > 0;
}

/** `text` with every finding replaced by SECRET_MASK; count — how many were replaced. */
export function maskSecrets(text: string, o: SecretDetectOptions = {}): { text: string; count: number } {
  const found = detectSecrets(text, o);
  if (found.length === 0) return { text, count: 0 };
  let out = "";
  let at = 0;
  for (const f of found) {
    out += text.slice(at, f.start) + SECRET_MASK;
    at = f.end;
  }
  return { text: out + text.slice(at), count: found.length };
}

/** `text` with the findings replaced by `replacement(finding, i)` (the chat puts secret://name in place of a saved key). */
export function replaceSecrets(
  text: string,
  replacement: (f: SecretFinding, i: number) => string,
  o: SecretDetectOptions = {},
): string {
  let out = "";
  let at = 0;
  detectSecrets(text, o).forEach((f, i) => {
    out += text.slice(at, f.start) + replacement(f, i);
    at = f.end;
  });
  return out + text.slice(at);
}
