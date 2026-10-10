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
import {
  domainHint,
  isDescriptionField,
  isNameField,
  isSlugField,
  realisticValue,
  slugify,
} from "./realistic.js";
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
        // A unique value is a day of the next 10 years (date: 100 years) and, once the counter has gone round them, a
        // minute of that day: probe generators start at 100 000 (G1) and 200 000 (G2), so on days alone they came
        // round to the seed's days (counter < 3650) — a duplicate slot of a unique index (23505, V3-15).
        const span = f.type === "date" ? 36_500 : 3650;
        const days = f.unique ? (n % span) + 1 : i + 1;
        const minutes = f.unique && f.type === "datetime" ? Math.floor(n / span) % 1440 : 0;
        const iso = new Date(this.now.getTime() + days * DAY_MS + minutes * 60_000).toISOString();
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
            // Unique: the counter keeps it unique; else the row's number («Адрес 1», not a global «Адрес 178»).
            return clip(`${f.label} ${f.unique ? n : i + 1}`, f);
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
  /**
   * The draft's demo data (seed_draft and the visual critic, V3-40), not a gate's seed: an entity a role reads through
   * a fixed row filter (a visitor reads published articles) has at least SHOWCASE_ROWS rows matching it and as many
   * that do not; publication dates lie in the past. Off — the seed of G1/G2 as it was.
   */
  showcase?: boolean;
}

/** Rows a visitor sees of an entity behind a fixed row filter in the draft's demo data (a blog shows three articles). */
export const SHOWCASE_ROWS = 3;
/** Publication dates of the demo data (`published_at`, `posted_on`, …): days before $now, never ahead of it. */
const PAST_DATE_FIELD = /^(published|posted|publish|written|issued)(_at|_on|_date)?$|^publication_date$/;

/** The first fixed row filter of an entity (only literal values: no $user.* or other $-reference), or null. */
function fixedRowFilter(spec: AppSpec, entity: string): Record<string, unknown> | null {
  for (const p of spec.permissions) {
    if (p.entity !== entity || !p.rowFilter) continue;
    const values = Object.values(p.rowFilter);
    if (values.length && values.every((v) => !(typeof v === "string" && v.startsWith("$"))))
      return p.rowFilter;
  }
  return null;
}

/** Makes a demo row miss the filter: its first enum or bool field of the filter gets another value. */
function missFilter(e: Entity, row: Record<string, unknown>, filter: Record<string, unknown>): void {
  for (const [field, want] of Object.entries(filter)) {
    if (row[field] !== want) return;
    const f = e.fields.find((x) => x.name === field);
    if (f?.type === "bool" && typeof want === "boolean") {
      row[field] = !want;
      return;
    }
    const other = f?.type === "enum" ? f.enum?.find((o) => o.value !== want) : undefined;
    if (other) {
      row[field] = other.value;
      return;
    }
  }
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

/** Rows generated so far and the entities by name: what a row's refs point to. */
interface SeedSoFar {
  rows: Record<string, Record<string, unknown>[]>;
  byName: Map<string, Entity>;
}

const titleOf = (e: Entity | undefined) =>
  e?.fields.find((f) => f.type === "string" && isNameField(f) && fieldPiiCategory(f) === "none");

/**
 * Row coherence after the hints: a line of an order names and prices the item it refers to and sums price × qty; a
 * name given by a hint drops the vocabulary's free text of the row (it described another item); a slug follows the
 * row's title in Latin («dizayn-kvartiry»), unique within the entity.
 */
function plausibleRow(
  e: Entity,
  row: Record<string, unknown>,
  hinted: (field: string) => boolean,
  slugs: Map<string, Set<string>>,
  so: SeedSoFar,
): void {
  const titleField = titleOf(e);
  // «Товар» of an order line = the name of its product row (a ref labelled as the line's name field).
  const ref = titleField
    ? e.fields.find((f) => f.type === "ref" && f.label === titleField.label && f.ref?.entity !== USERS_ENTITY)
    : undefined;
  const target = ref ? so.rows[ref.ref?.entity as string]?.find((r) => r.id === row[ref.name]) : undefined;
  if (titleField && target) {
    const te = so.byName.get(ref?.ref?.entity as string);
    const name = target[titleOf(te)?.name ?? ""];
    if (typeof name === "string" && !hinted(titleField.name)) row[titleField.name] = name;
    const price = e.fields.find((f) => f.type === "money" && f.name === "price");
    if (price && !hinted(price.name) && typeof target.price === "number") row.price = target.price;
  }
  const qty = e.fields.find((f) => f.type === "int" && /^(qty|quantity)$/.test(f.name));
  const sum = e.fields.find((f) => f.type === "money" && /^(sum|line_total)$/.test(f.name));
  if (qty && sum && !hinted(sum.name) && typeof row.price === "number" && typeof row[qty.name] === "number") {
    const v = (row.price as number) * (row[qty.name] as number);
    if (sum.max === undefined || v <= sum.max) row[sum.name] = v;
  }
  const title = titleField ? row[titleField.name] : undefined;
  if (titleField && hinted(titleField.name))
    for (const f of e.fields)
      if (
        f !== titleField &&
        !f.required &&
        !hinted(f.name) &&
        isDescriptionField(f) &&
        fieldPiiCategory(f) === "none"
      )
        delete row[f.name];
  for (const f of e.fields) {
    if (!isSlugField(f) || fieldPiiCategory(f) !== "none") continue;
    const used = slugs.get(f.name) ?? new Set<string>();
    slugs.set(f.name, used);
    const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type] ?? 80;
    const base = !hinted(f.name) && typeof title === "string" ? slugify(title, max - 3) : "";
    let slug = base;
    for (let k = 2; slug && used.has(slug); k++) slug = `${base}-${k}`;
    if (slug && nonSyntheticPii(slug).length === 0) row[f.name] = slug;
    if (typeof row[f.name] === "string") used.add(row[f.name] as string);
  }
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
    const showcase = opts.showcase && fixedRowFilter(spec, e.name) ? SHOWCASE_ROWS * 2 : 0;
    counts.set(e.name, Math.min(SEED_HINT_MAX_VALUES, Math.max(3, enums, rf * 2, showcase)));
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
    const slugs = new Map<string, Set<string>>();
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
      plausibleRow(e, row, (f) => hints.get(`${name}.${f}`)?.[i] !== undefined, slugs, { rows, byName });
      const owner = owners[i];
      if (owner) {
        for (const [field, want] of Object.entries(owner.filter)) {
          const m = typeof want === "string" ? /^\$user\.([a-z_]+)$/.exec(want) : null;
          row[field] = m ? userAttr(owner.user, m[1] as string) : want;
        }
      }
      if (opts.showcase) {
        // Every other row is what the filtered role sees (published), the rest is not (drafts stay drafts).
        const fixed = owner ? null : fixedRowFilter(spec, name);
        if (fixed && i % 2 === 0) Object.assign(row, fixed);
        else if (fixed) missFilter(e, row, fixed);
        for (const f of e.fields)
          if ((f.type === "date" || f.type === "datetime") && !f.unique && PAST_DATE_FIELD.test(f.name)) {
            const iso = new Date(now.getTime() - (i + 1) * DAY_MS).toISOString();
            row[f.name] = f.type === "date" ? iso.slice(0, 10) : iso;
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
