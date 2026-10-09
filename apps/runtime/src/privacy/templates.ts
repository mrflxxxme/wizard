// Versioned registry of legal templates of the 152-ФЗ package (security/compliance.yaml#system_package.policy_page,
// #consent.text). Texts come from the lawyer (E-LEGAL); until then the built-in files in apps/runtime/templates are
// drafts that MUST carry DRAFT_MARK. Swapping: files with the same {kind, id} in WIZARD_LEGAL_TEMPLATES_DIR (or
// LegalTemplates.register) replace the built-in ones; nothing in the code holds legal wording.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** policy and consent — 152-ФЗ; shop — the seller's terms of «Интернет-магазин» (offer, delivery, returns; V3-18). */
export type LegalTemplateKind = "policy" | "consent" | "shop";

export interface LegalTemplate {
  id: string;
  kind: LegalTemplateKind;
  /** Version of the template text (the lawyer's revision); the policy version hashes the rendered text anyway. */
  version: string;
  /** draft — placeholder until the lawyer; approved — the lawyer's text (platform.beta_readiness (6)). */
  status: "draft" | "approved";
  /** Markdown subset with {{placeholders}}. */
  body: string;
  /** File it was read from (diagnostics). */
  source?: string;
}

/** Marker every draft template carries (and an approved one must not). */
export const DRAFT_MARK = "ЧЕРНОВИК — требует согласования юристом";

/** Built-in drafts shipped with the runtime. */
export const BUILTIN_TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

const ID_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const FRONT_RE = /^---\n([\s\S]*?)\n---\n?/;

export class LegalTemplateError extends Error {
  override name = "LegalTemplateError";
}

/** Parses `---\nid: …\nkind: …\nversion: …\nstatus: …\n---\n<body>`. */
export function parseLegalTemplate(text: string, source?: string): LegalTemplate {
  const norm = text.replace(/\r\n/g, "\n");
  const m = FRONT_RE.exec(norm);
  if (!m) throw new LegalTemplateError(`${source ?? "template"}: no front matter`);
  const meta: Record<string, string> = {};
  for (const line of (m[1] as string).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const t: LegalTemplate = {
    id: meta.id ?? "",
    kind: meta.kind as LegalTemplateKind,
    version: meta.version ?? "",
    status: meta.status as LegalTemplate["status"],
    body: norm.slice(m[0].length).trim(),
    ...(source ? { source } : {}),
  };
  validate(t);
  return t;
}

function validate(t: LegalTemplate): void {
  const where = t.source ?? `${t.kind}:${t.id}`;
  if (!ID_RE.test(t.id)) throw new LegalTemplateError(`${where}: invalid id`);
  if (t.kind !== "policy" && t.kind !== "consent" && t.kind !== "shop")
    throw new LegalTemplateError(`${where}: invalid kind`);
  if (t.status !== "draft" && t.status !== "approved")
    throw new LegalTemplateError(`${where}: invalid status`);
  if (!t.version) throw new LegalTemplateError(`${where}: version is required`);
  if (!t.body) throw new LegalTemplateError(`${where}: empty body`);
  const marked = t.body.includes(DRAFT_MARK);
  if (t.status === "draft" && !marked)
    throw new LegalTemplateError(`${where}: a draft must contain «${DRAFT_MARK}»`);
  if (t.status === "approved" && marked)
    throw new LegalTemplateError(`${where}: an approved text keeps the draft mark`);
}

const key = (kind: LegalTemplateKind, id: string) => `${kind}:${id}`;

export class LegalTemplates {
  private readonly map = new Map<string, LegalTemplate>();

  /** Adds or replaces the template with the same {kind, id} (the swap mechanism). */
  register(t: LegalTemplate): this {
    validate(t);
    this.map.set(key(t.kind, t.id), { ...t });
    return this;
  }

  /** Every *.md file of `dir` (front matter decides kind and id; the file name does not matter). */
  loadDir(dir: string): this {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      this.register(parseLegalTemplate(readFileSync(path, "utf8"), path));
    }
    return this;
  }

  get(kind: LegalTemplateKind, id: string): LegalTemplate | undefined {
    return this.map.get(key(kind, id));
  }

  list(): LegalTemplate[] {
    return [...this.map.values()];
  }

  /** `kind:id` of templates still waiting for the lawyer (platform.beta_readiness (6)). */
  pending(): string[] {
    return this.list()
      .filter((t) => t.status === "draft")
      .map((t) => key(t.kind, t.id));
  }
}

/** Built-in drafts plus overrides from `overrideDir` (default: WIZARD_LEGAL_TEMPLATES_DIR). */
export function loadLegalTemplates(overrideDir = process.env.WIZARD_LEGAL_TEMPLATES_DIR): LegalTemplates {
  const reg = new LegalTemplates().loadDir(BUILTIN_TEMPLATES_DIR);
  if (overrideDir) reg.loadDir(overrideDir);
  return reg;
}

let defaults: LegalTemplates | undefined;

/** Process-wide registry used when a caller passes none (loaded once). */
export function defaultLegalTemplates(): LegalTemplates {
  defaults ??= loadLegalTemplates();
  return defaults;
}

const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** Substitutes {{name}}; an unknown placeholder is kept as is, so a missing value is visible in review. */
export function fillTemplate(body: string, vars: Readonly<Record<string, string>>): string {
  return body.replace(VAR_RE, (all, name: string) =>
    Object.hasOwn(vars, name) ? (vars[name] as string) : all,
  );
}
