// Seed generator (specs/agents/qa.yaml#seed): deterministic, synthetic only, DLP-checked before loading.
import { createHash } from "node:crypto";
import {
  type AppSpec,
  fieldPiiCategory as appspecPiiCategory,
  DEFAULT_MAX_LENGTH,
  type Entity,
  type Field,
  USERS_ENTITY,
} from "@wizard/appspec";
import { classifyFieldName, detect } from "@wizard/pii";
import { domainHint, realisticValue } from "./realistic.js";
import type { Seed, SeedHint, SeedUser } from "./types.js";

/** Built-in synthetic dictionary (qa.yaml#seed.rules): the only names seeds and G1 actors ever get. */
export const SYNTHETIC_NAMES = {
  male: ["Иван", "Пётр", "Борис", "Глеб", "Олег", "Степан"],
  female: ["Анна", "Вера", "Ольга", "Дарья", "Ирина", "Нина"],
  surnames: ["Тестов", "Примеров", "Образцов", "Макетов", "Шаблонов", "Пробин"],
} as const;

const NAME_WORDS: ReadonlySet<string> = new Set([
  ...SYNTHETIC_NAMES.male,
  ...SYNTHETIC_NAMES.female,
  ...SYNTHETIC_NAMES.surnames,
  ...SYNTHETIC_NAMES.surnames.map((s) => `${s}а`),
]);

/** n ≥ 1 → «Анна Тестова»-style name from the synthetic dictionary. */
export function syntheticName(n: number): string {
  const female = n % 2 === 1;
  const first = (female ? SYNTHETIC_NAMES.female : SYNTHETIC_NAMES.male)[Math.floor(n / 2) % 6] as string;
  const stem = SYNTHETIC_NAMES.surnames[(n * 5) % 6] as string;
  return `${first} ${female ? `${stem}а` : stem}`;
}
export const syntheticEmail = (n: number) => `user${n}@example.test`;
/** +7 999 000-XX-XX (stored as E.164). */
export const syntheticPhone = (n: number) => `+7999000${String(n % 10_000).padStart(4, "0")}`;
export const syntheticAddress = (n: number) => `ул. Тестовая, д. ${n}`;
const syntheticText = (n: number) => `Тестовый текст ${n}`;

const SYNTHETIC_PATTERNS: readonly RegExp[] = [
  /^user\d+@example\.test$/,
  /^\+7999000\d{4}$/,
  /^ул\. Тестовая, д\. \d+$/,
  /^Тестовый текст \d+$/,
];

/** Whole value comes from the generator (dictionary name or synthetic pattern). */
export function isSyntheticValue(v: string): boolean {
  if (SYNTHETIC_PATTERNS.some((re) => re.test(v))) return true;
  const words = v.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => NAME_WORDS.has(w));
}

/** Kinds of personal data `detect()` finds in `v` outside the synthetic dictionary/patterns (the seed DLP rule). */
export function nonSyntheticPii(v: string): string[] {
  return detect(v)
    .filter((f) => !isSyntheticValue(v.slice(f.start, f.end)))
    .map((f) => f.kind);
}

/** Deterministic UUID (v4 layout) from the seed key and a path. */
export function uuidFor(key: string, ...parts: (string | number)[]): string {
  const h = createHash("sha256")
    .update([key, ...parts].join("\u0000"))
    .digest("hex");
  const variant = ((Number.parseInt(h[16] as string, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type PiiShape = "name" | "email" | "phone" | "address" | "text" | "none" | "forbidden";

/** PII category of a field (file → basic): the shared @wizard/appspec definition (B2-46). */
export const fieldPiiCategory: (f: Field) => string = appspecPiiCategory;

function piiShape(f: Field): PiiShape {
  if (fieldPiiCategory(f) === "none") return "none";
  if (f.type === "email") return "email";
  if (f.type === "phone") return "phone";
  const kind = f.piiKind ?? classifyFieldName(f.name, f.label)?.piiKind;
  switch (kind) {
    case "fio":
      return "name";
    case "email":
      return "email";
    case "phone":
      return "phone";
    case "address":
      return "address";
    case "passport":
    case "snils":
    case "inn":
    case "card":
      return "forbidden";
    default:
      return "text";
  }
}

function clip(s: string, f: Field): string {
  const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type];
  return max !== undefined && [...s].length > max ? [...s].slice(-max).join("") : s;
}

const DAY_MS = 86_400_000;

/**
 * Field values for seeds and G1 probes. `next()` gives a fresh number, so strings, emails, phones and numbers of
 * unique fields never repeat within one generator; probes use a separate range (start) from the seed.
 */
export interface ValueGenOptions {
  /** Seed key: plausible pii=none values (realistic.ts) vary by it. */
  key?: string;
  /** domainHint(spec): picks domain vocabularies (bakery, events). */
  hint?: string;
}

/** The field is part of a unique index of the entity (single or composite). */
export function inUniqueIndex(e: Entity, field: string): boolean {
  return (e.indexes ?? []).some((ix) => ix.unique === true && ix.fields.includes(field));
}

export class ValueGen {
  private n: number;
  constructor(
    readonly now: Date,
    start = 1,
    readonly opts: ValueGenOptions = {},
  ) {
    this.n = start - 1;
  }

  next(): number {
    this.n += 1;
    return this.n;
  }

  /** Value of a non-ref field for row `i`; undefined → leave the column NULL/default. */
  value(e: Entity, field: Field, i: number): unknown {
    // A field of a unique index (one booking per time) gets fresh values like a unique field.
    const f = !field.unique && inUniqueIndex(e, field.name) ? { ...field, unique: true } : field;
    const n = this.next();
    const shape = piiShape(f);
    if (shape === "forbidden") return undefined; // cards/passports are never generated (qa.yaml#seed.rules)
    if (shape === "none") {
      const v = realisticValue({
        key: this.opts.key ?? "",
        hint: this.opts.hint ?? "",
        entity: e,
        field: f,
        i,
        n,
      });
      if (v === null) return undefined;
      const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type];
      // A plausible value the seed DLP would flag (e.g. a digit run read as a phone) falls back to the synthetic one:
      // the generator never trips its own DLP (FU-5: random SEED_PII errors of G1).
      if (typeof v !== "string") {
        if (v !== undefined) return v;
      } else if ((max === undefined || [...v].length <= max) && nonSyntheticPii(v).length === 0) return v;
    }
    switch (f.type) {
      case "enum": {
        const opts = f.enum ?? [];
        return opts[i % Math.max(opts.length, 1)]?.value;
      }
      case "bool":
        return i % 2 === 0;
      case "int": {
        const lo = Math.ceil(f.min ?? Math.min(1, f.max ?? 1));
        const hi = Math.floor(f.max ?? lo + 1_000_000_000);
        const span = Math.max(hi - lo + 1, 1);
        return lo + ((f.unique ? n : i) % span);
      }
      case "decimal": {
        const lo = f.min ?? 0;
        const v = lo + (f.unique ? n : i) + 0.5;
        return f.max !== undefined ? Math.min(v, f.max) : v;
      }
      case "money": {
        const lo = f.min ?? 0;
        let v = Math.max(Math.ceil(lo / 100) * 100, 100) + (f.unique ? n : i) * 100;
        if (f.max !== undefined && v > f.max)
          v = Math.floor(f.max / 100) * 100 >= lo ? Math.floor(f.max / 100) * 100 : f.max;
        return v;
      }
      case "date":
      case "datetime": {
        const days = f.unique ? (n % 3650) + 1 : i + 1;
        const iso = new Date(this.now.getTime() + days * DAY_MS).toISOString();
        return f.type === "date" ? iso.slice(0, 10) : iso;
      }
      case "json":
        return { n };
      case "email":
        return syntheticEmail(n);
      case "phone":
        return syntheticPhone(n);
      case "url":
        return clip(`https://example.test/${e.name}/${n}`, f);
      case "file":
      case "image":
        return f.required ? `seed/${e.name}/${n}.png` : undefined;
      case "qr_token":
        return f.required ? createHash("sha256").update(`qr${n}`).digest("base64url") : undefined;
      case "ref":
        return undefined;
      default:
        switch (shape) {
          case "name":
            return clip(syntheticName(n), f);
          case "email":
            return clip(syntheticEmail(n), f);
          case "phone":
            return clip(syntheticPhone(n), f);
          case "address":
            return clip(syntheticAddress(n), f);
          case "text":
            return clip(syntheticText(n), f);
          default:
            return clip(`${f.label} ${n}`, f);
        }
    }
  }
}

/** Value of `$user.<attr>` for a seed user. */
export function userAttr(u: SeedUser, attr: string): unknown {
  switch (attr) {
    case "id":
      return u.id;
    case "role":
      return u.role;
    case "email":
      return u.email;
    case "phone":
      return u.phone;
    case "display_name":
      return u.display_name;
    default:
      return null;
  }
}

/** Entities ordered so that every required ref points to an earlier entity (cycles keep spec order). */
export function insertOrder(spec: AppSpec): string[] {
  const names = spec.entities.map((e) => e.name);
  const deps = new Map(
    spec.entities.map((e) => [
      e.name,
      new Set(
        e.fields
          .filter(
            (f) => f.type === "ref" && f.ref && f.ref.entity !== USERS_ENTITY && f.ref.entity !== e.name,
          )
          .map((f) => f.ref?.entity as string),
      ),
    ]),
  );
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < names.length) {
    const ready = names.find((n) => !done.has(n) && [...(deps.get(n) ?? [])].every((d) => done.has(d)));
    const pick = ready ?? (names.find((n) => !done.has(n)) as string);
    out.push(pick);
    done.add(pick);
  }
  return out;
}

export interface SeedOptions {
  /** $now for dates (default: start of the current UTC day). */
  now?: Date;
  /** QA hints (qa.yaml#seed.rules MAY); invalid ones are ignored, see validateSeedHint. */
  hints?: readonly SeedHint[];
}

/** Rows per entity never exceed this, so a hint has at most as many values. */
export const SEED_HINT_MAX_VALUES = 10;
const HINT_TYPES = new Set(["string", "text", "enum", "int", "decimal", "money", "bool"]);

/** Problems of one seed hint (Russian, for the QA repeat); [] = the generator takes it. */
export function validateSeedHint(spec: AppSpec, h: SeedHint): string[] {
  const where = `seedHints ${String(h?.entity)}.${String(h?.field)}`;
  const e = spec.entities.find((x) => x.name === h?.entity);
  if (!e) return [`${where}: нет сущности «${String(h?.entity)}»`];
  const f = e.fields.find((x) => x.name === h.field);
  if (!f) return [`${where}: нет поля «${String(h.field)}»`];
  if (fieldPiiCategory(f) !== "none")
    return [`${where}: поле с персональными данными — только генератор синтетики`];
  if (!HINT_TYPES.has(f.type))
    return [`${where}: подсказки только для полей string, text, enum, int, decimal, money, bool`];
  if (f.unique) return [`${where}: уникальное поле — значения даёт только генератор`];
  if (!Array.isArray(h.values) || h.values.length < 1 || h.values.length > SEED_HINT_MAX_VALUES)
    return [`${where}: нужно от 1 до ${SEED_HINT_MAX_VALUES} значений`];
  const errs: string[] = [];
  const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type];
  const inRange = (v: number) => (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
  for (const [i, v] of h.values.entries()) {
    const bad = (why: string) => errs.push(`${where}[${i}]: ${why}`);
    switch (f.type) {
      case "string":
      case "text":
        if (typeof v !== "string" || v.trim() === "") bad("ожидается непустая строка");
        else if (max !== undefined && [...v].length > max) bad(`длиннее ${max} символов`);
        else if (nonSyntheticPii(v).length) bad("похоже на персональные данные (SEED_PII)");
        break;
      case "enum":
        if (!(f.enum ?? []).some((o) => o.value === v)) bad("значения нет в enum поля");
        break;
      case "bool":
        if (typeof v !== "boolean") bad("ожидается true или false");
        break;
      case "int":
        if (typeof v !== "number" || !Number.isInteger(v) || !inRange(v))
          bad("ожидается целое в пределах min/max");
        break;
      case "decimal":
        if (typeof v !== "number" || !Number.isFinite(v) || !inRange(v))
          bad("ожидается число в пределах min/max");
        break;
      case "money":
        if (typeof v !== "number" || !Number.isInteger(v) || v % 100 !== 0 || !inRange(v))
          bad("ожидается сумма, кратная 100, в пределах min/max");
        break;
    }
  }
  return errs;
}

/** Valid hints merged per entity.field: for each row index the first hint that sets it wins. */
export function mergeSeedHints(spec: AppSpec, hints: readonly SeedHint[]): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const h of hints) {
    if (validateSeedHint(spec, h).length) continue;
    const key = `${h.entity}.${h.field}`;
    const cur = out.get(key) ?? [];
    h.values.forEach((v, i) => {
      if (cur[i] === undefined) cur[i] = v;
    });
    out.set(key, cur);
  }
  return out;
}

/** gates.generateSeed(spec, key) — architecture.yaml#interfaces.gates, qa.yaml#seed. */
export function generateSeed(spec: AppSpec, key: string, opts: SeedOptions = {}): Seed {
  const now = opts.now ?? new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
  const gen = new ValueGen(now, 1, { key, hint: domainHint(spec) });
  const hints = mergeSeedHints(spec, opts.hints ?? []);
  const users: SeedUser[] = [];
  for (const r of spec.roles) {
    if (r.access !== "login") continue;
    for (let k = 0; k < 2; k++) {
      const n = gen.next();
      users.push({
        id: uuidFor(key, "users", r.name, k),
        role: r.name,
        display_name: syntheticName(n),
        email: syntheticEmail(n),
        phone: syntheticPhone(n),
      });
    }
  }
  const order = insertOrder(spec);
  const rows: Record<string, Record<string, unknown>[]> = {};
  const counts = new Map<string, number>();
  for (const e of spec.entities) {
    const rf = spec.permissions.filter((p) => p.entity === e.name && p.rowFilter).length;
    const enums = Math.max(0, ...e.fields.map((f) => (f.type === "enum" ? (f.enum?.length ?? 0) : 0)));
    counts.set(e.name, Math.min(10, Math.max(3, enums, rf * 2)));
  }
  const byName = new Map(spec.entities.map((e) => [e.name, e]));
  for (const name of order) {
    const e = byName.get(name) as Entity;
    const count = counts.get(name) ?? 3;
    // Rows owned by users A and B of every role whose permission on this entity has a rowFilter.
    const owners: { user: SeedUser; filter: Record<string, unknown> }[] = [];
    for (const p of spec.permissions) {
      if (p.entity !== name || !p.rowFilter) continue;
      for (const u of users.filter((x) => x.role === p.role)) owners.push({ user: u, filter: p.rowFilter });
    }
    const list: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const row: Record<string, unknown> = { id: uuidFor(key, name, i) };
      for (const f of e.fields) {
        if (f.type === "ref") {
          const target = f.ref?.entity as string;
          if (target === USERS_ENTITY) {
            row[f.name] = users.length
              ? (users[(i + e.fields.indexOf(f)) % users.length] as SeedUser).id
              : null;
          } else if (target === name) {
            row[f.name] = f.required ? uuidFor(key, name, i > 0 ? i - 1 : 0) : null;
          } else {
            const t = rows[target];
            row[f.name] = t?.length ? (t[i % t.length] as Record<string, unknown>).id : null;
          }
          continue;
        }
        const v = gen.value(e, f, i);
        const hinted = hints.get(`${name}.${f.name}`)?.[i];
        if (hinted !== undefined) row[f.name] = hinted;
        else if (v !== undefined) row[f.name] = v;
      }
      const owner = owners[i];
      if (owner) {
        for (const [field, want] of Object.entries(owner.filter)) {
          const m = typeof want === "string" ? /^\$user\.([a-z_]+)$/.exec(want) : null;
          row[field] = m ? userAttr(owner.user, m[1] as string) : want;
        }
      }
      list.push(row);
    }
    rows[name] = list;
  }
  return { key, now: now.toISOString(), users, rows, order };
}

export interface DlpFinding {
  /** JSON Pointer into the seed. */
  path: string;
  kind: string;
}

const SKIP_TYPES = new Set(["ref", "qr_token", "date", "datetime", "enum", "file", "image"]);

/** DLP over a seed (qa.yaml#seed.rules): anything that looks like personal data but is not synthetic → SEED_PII. */
export function seedDlp(spec: AppSpec, seed: Seed): DlpFinding[] {
  const out: DlpFinding[] = [];
  const scan = (path: string, value: unknown, piiField: boolean) => {
    if (typeof value !== "string") return;
    if (piiField && !isSyntheticValue(value)) {
      out.push({ path, kind: "non_synthetic_pii_field" });
      return;
    }
    for (const kind of nonSyntheticPii(value)) out.push({ path, kind });
  };
  seed.users.forEach((u, i) => {
    scan(`/users/${i}/display_name`, u.display_name, true);
    scan(`/users/${i}/email`, u.email, true);
    scan(`/users/${i}/phone`, u.phone, true);
  });
  for (const e of spec.entities) {
    (seed.rows[e.name] ?? []).forEach((row, i) => {
      for (const f of e.fields) {
        if (SKIP_TYPES.has(f.type)) continue;
        const v = f.type === "json" ? JSON.stringify(row[f.name] ?? null) : row[f.name];
        scan(`/rows/${e.name}/${i}/${f.name}`, v, fieldPiiCategory(f) !== "none" && f.type !== "json");
      }
    });
  }
  return out;
}
