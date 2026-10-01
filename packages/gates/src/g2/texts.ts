// Corpus of G2 antifraud: texts of the spec and of ui/** and functions/** with their zone
// (abuse.yaml#patterns.brands.zones, scope) and code signals (password inputs, autocomplete, external URLs,
// crypto wallets, Luhn, card masks). Every text is normalized once (patterns.normalize).
import type { AppSpec } from "@wizard/appspec";
import ts from "typescript";
import { nodeLine, parseAll, type SourceInfo, unwrap } from "../g0/source.js";
import { ABUSE, normalize, splitIdent } from "./patterns.js";

export type Zone = "identity" | "forms" | "text";

export interface TextItem {
  raw: string;
  norm: string;
  zone: Zone;
  /** identity: app.name | slug | page.title | logo | operator; others: where the text came from. */
  kind: string;
  /** A label, name or placeholder of an input (spec field or form control). */
  input?: { type?: string };
  file?: string;
  line?: number;
  path?: string;
}

export type SignalKind =
  | "password_input"
  | "autocomplete"
  | "external_post"
  | "external_frame"
  | "crypto"
  | "crypto_weak"
  | "hex_address"
  | "luhn"
  | "card_mask"
  | "egress";

export interface CodeSignal {
  kind: SignalKind;
  detail: string;
  file: string;
  line: number;
  value?: string;
}

export interface Corpus {
  items: TextItem[];
  signals: CodeSignal[];
  /** Count of distinct external hosts linked from ui/** (scoring external_links_gt_5). */
  externalHosts: Set<string>;
  sources: SourceInfo[];
}

const INPUT_TAGS = new Set(["Field", "input", "textarea", "select", "RecordForm", "form"]);
const BUTTON_TAGS = new Set(["Button", "button", "label", "legend"]);
const TITLE_TAGS = new Set(["AppShell", "CabinetLayout"]);
const FIELD_ATTRS = new Set(["label", "placeholder", "submitLabel"]);
const TEXT_ATTRS = new Set(["title", "alt", "aria-label", "emptyText", "description", "hint"]);
const ABS_URL_RE = /^(?:https?:)?\/\/([^/?#\s]+)/i;
const CARD_MASK_RE =
  /(?:\\d\{4\}|\[0-9\]\{4\}|[09#Xx*]{4})(?:[ -]|\\s|\[ -\]|\\-)?\??(?:\\d\{4\}|\[0-9\]\{4\}|[09#Xx*]{4})(?:[ -]|\\s|\[ -\]|\\-)?\??(?:\\d\{4\}|\[0-9\]\{4\}|[09#Xx*]{4})(?:[ -]|\\s|\[ -\]|\\-)?\??(?:\\d\{4\}|\[0-9\]\{4\}|[09#Xx*]{4})|\\d\{16\}|\[0-9\]\{16\}/;
const HEX_ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/;

function tagName(el: ts.JsxOpeningLikeElement): string {
  return el.tagName.getText();
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  for (const p of el.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name) return p;
  }
  return undefined;
}

/** Literal text of an attribute / expression: string, no-substitution template, or template head+spans. */
function literalText(e: ts.Node | undefined): { text: string; dynamic: boolean } | null {
  if (!e) return null;
  if (ts.isJsxAttribute(e)) return literalText(e.initializer);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text, dynamic: false };
  if (ts.isJsxExpression(e)) return e.expression ? literalText(unwrap(e.expression)) : null;
  if (ts.isTemplateExpression(e)) {
    return {
      text: [e.head.text, ...e.templateSpans.map((s) => ` ${s.literal.text}`)].join(""),
      dynamic: true,
    };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = literalText(unwrap(e.left));
    if (l) return { text: l.text, dynamic: true };
  }
  return null;
}

function enclosingFn(n: ts.Node): ts.Node {
  for (let a = n.parent; a; a = a.parent) {
    if (ts.isFunctionLike(a) || ts.isSourceFile(a)) return a;
  }
  return n.getSourceFile();
}

function jsxAncestors(n: ts.Node): string[] {
  const out: string[] = [];
  for (let a = n.parent; a && !ts.isFunctionLike(a); a = a.parent) {
    if (ts.isJsxElement(a)) out.push(tagName(a.openingElement));
  }
  return out;
}

const isAbs = (url: string) => ABS_URL_RE.exec(url)?.[1]?.toLowerCase() ?? null;

class Collector {
  readonly items: TextItem[] = [];
  readonly signals: CodeSignal[] = [];
  readonly externalHosts = new Set<string>();
  private readonly formy = new Map<ts.Node, boolean>();

  add(raw: string, zone: Zone, kind: string, where: Omit<TextItem, "raw" | "norm" | "zone" | "kind">) {
    const t = raw.trim();
    if (!t) return;
    this.items.push({ raw: t, norm: normalize(t), zone, kind, ...where });
  }

  signal(kind: SignalKind, detail: string, node: ts.Node, value?: string) {
    this.signals.push({
      kind,
      detail,
      file: node.getSourceFile().fileName,
      line: nodeLine(node),
      ...(value !== undefined ? { value } : {}),
    });
  }

  /** Does the component (nearest function) render inputs? Its button/label texts are then the forms zone. */
  private isFormy(n: ts.Node): boolean {
    const fn = enclosingFn(n);
    let v = this.formy.get(fn);
    if (v === undefined) {
      v = false;
      const visit = (x: ts.Node) => {
        if (v) return;
        if ((ts.isJsxOpeningElement(x) || ts.isJsxSelfClosingElement(x)) && INPUT_TAGS.has(tagName(x)))
          v = true;
        else ts.forEachChild(x, visit);
      };
      visit(fn);
      this.formy.set(fn, v);
    }
    return v;
  }

  /** External URL: "always" (form action, frames, requests) or only with parameters (links, redirects). */
  private url(
    node: ts.Node,
    value: ts.Node | undefined,
    what: string,
    mode: "always" | "params" | "frame" = "params",
  ) {
    const lit = literalText(value);
    if (!lit) return;
    const host = isAbs(lit.text);
    if (!host) return;
    this.externalHosts.add(host);
    if (mode === "frame") this.signal("external_frame", `${what} на внешний хост ${host}`, node, host);
    else if (mode === "always" || lit.dynamic || /[?&][^=]+=/.test(lit.text))
      this.signal("external_post", `${what} на внешний хост ${host}`, node, host);
  }

  ui(src: SourceInfo) {
    const where = (n: ts.Node) => ({ file: src.path, line: nodeLine(n) });
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        const spec = (n.moduleSpecifier as ts.StringLiteral | undefined)?.text ?? "";
        if (/^(ethers|web3|@walletconnect|walletconnect|@solana)/.test(spec))
          this.signal("crypto", `импорт ${spec}`, n, spec);
        return;
      }
      if (ts.isJsxText(n)) {
        const formy = this.isFormy(n) && jsxAncestors(n).some((t) => BUTTON_TAGS.has(t));
        this.add(n.text, formy ? "forms" : "text", "jsx", where(n));
        return;
      }
      if (
        ts.isJsxExpression(n) &&
        n.expression &&
        (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
      ) {
        const lit = literalText(unwrap(n.expression));
        if (lit) {
          const formy = this.isFormy(n) && jsxAncestors(n).some((t) => BUTTON_TAGS.has(t));
          this.add(lit.text, formy ? "forms" : "text", "jsx", where(n));
          return;
        }
      }
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) this.element(n, src);
      if (ts.isPropertyAssignment(n) && !ts.isJsxAttribute(n.parent)) {
        const key = n.name.getText().replace(/^["']|["']$/g, "");
        const lit = literalText(unwrap(n.initializer));
        if (lit && (key === "label" || key === "placeholder" || key === "title")) {
          this.add(lit.text, this.isFormy(n) && key !== "title" ? "forms" : "text", `prop.${key}`, where(n));
          stringSignals(this, n.initializer, lit.text);
          return;
        }
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const p = n.parent;
        if (
          p &&
          (ts.isJsxAttribute(p) ||
            (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) ||
            ts.isImportDeclaration(p) ||
            ts.isExternalModuleReference(p))
        )
          return;
        const lit = literalText(n);
        if (lit && /\p{L}{2,}\s|\P{ASCII}/u.test(lit.text)) this.add(lit.text, "text", "string", where(n));
        if (lit) stringSignals(this, n, lit.text);
        if (ts.isTemplateExpression(n)) return;
      }
      if (ts.isRegularExpressionLiteral(n) && CARD_MASK_RE.test(n.text))
        this.signal("card_mask", "маска номера карты", n);
      this.code(n);
      ts.forEachChild(n, visit);
    };
    visit(src.sf);
  }

  private element(el: ts.JsxOpeningLikeElement, src: SourceInfo) {
    const tag = tagName(el);
    const where = (n: ts.Node) => ({ file: src.path, line: nodeLine(n) });
    const typeAttr = literalText(attr(el, "type"))?.text;
    const formy = this.isFormy(el);
    for (const p of el.attributes.properties) {
      if (!ts.isJsxAttribute(p)) continue;
      const name = p.name.getText();
      const lit = literalText(p);
      if (name === "type" && lit?.text.toLowerCase() === "password")
        this.signal("password_input", `поле ввода пароля (<${tag} type="password">)`, p);
      if ((name === "autoComplete" || name === "autocomplete") && lit)
        this.signal("autocomplete", `autocomplete="${lit.text}"`, p, lit.text.toLowerCase());
      if (name === "action" && tag === "form") this.url(p, p.initializer, "форма отправляется", "always");
      if (name === "href") this.url(p, p.initializer, "ссылка");
      if (name === "src" && (tag === "iframe" || tag === "script"))
        this.url(p, p.initializer, `<${tag}>`, "frame");
      if (!lit) continue;
      if (FIELD_ATTRS.has(name) && (INPUT_TAGS.has(tag) || BUTTON_TAGS.has(tag) || formy)) {
        this.add(lit.text, "forms", `attr.${name}`, {
          ...where(p),
          ...(INPUT_TAGS.has(tag) ? { input: typeAttr ? { type: typeAttr } : {} } : {}),
        });
      } else if (name === "name" && INPUT_TAGS.has(tag) && tag !== "form") {
        this.add(splitIdent(lit.text), "forms", "attr.name", {
          ...where(p),
          input: typeAttr ? { type: typeAttr } : {},
        });
      } else if (name === "title" && TITLE_TAGS.has(tag)) {
        this.add(lit.text, "identity", "page.title", where(p));
      } else if (TEXT_ATTRS.has(name) || FIELD_ATTRS.has(name)) {
        this.add(lit.text, "text", `attr.${name}`, where(p));
      }
      stringSignals(this, p, lit.text);
    }
  }

  /** Calls / member accesses shared by ui and functions. */
  code(n: ts.Node) {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const name = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : ts.isStringLiteralLike(n.argumentExpression)
          ? n.argumentExpression.text
          : "";
      const root = unwrap(n.expression);
      if (name === "ethereum" && ts.isIdentifier(root) && /^(window|globalThis|self)$/.test(root.text))
        this.signal("crypto", "обращение к кошельку window.ethereum", n);
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      if (name === "setApprovalForAll") this.signal("crypto", "вызов setApprovalForAll", n);
      if ((name === "approve" && n.arguments.length === 2) || (name === "permit" && n.arguments.length >= 5))
        if (ts.isPropertyAccessExpression(callee)) this.signal("crypto_weak", `вызов ${name}(…)`, n);
      const full = callee.getText();
      if (/^(window\.)?(location\.(assign|replace)|open)$/.test(full) || full === "window.open")
        this.url(n, n.arguments[0], "переход");
      if (/^(fetch|navigator\.sendBeacon|window\.fetch)$/.test(full))
        this.url(n, n.arguments[0], "запрос", "always");
    }
    if (ts.isNewExpression(n) && /^(WebSocket|EventSource|XMLHttpRequest)$/.test(n.expression.getText()))
      this.url(n, n.arguments?.[0], "соединение", "always");
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /(^|\.)location(\.href)?$/.test(n.left.getText())
    )
      this.url(n, n.right, "переход");
    if (ts.isFunctionLike(n) && "body" in n && n.body) {
      const body = n.body.getText();
      if (/%\s*10\b/.test(body) && /\*\s*2\b|<<\s*1\b/.test(body) && /-\s*9\b|>\s*9\b/.test(body))
        this.signal("luhn", "проверка номера карты по алгоритму Луна", n);
    }
  }

  functions(src: SourceInfo) {
    const where = (n: ts.Node) => ({ file: src.path, line: nodeLine(n) });
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const lit = literalText(n);
        if (lit && /\p{L}{2,}\s|\P{ASCII}/u.test(lit.text)) this.add(lit.text, "text", "string", where(n));
        if (lit) stringSignals(this, n, lit.text);
      }
      if (ts.isRegularExpressionLiteral(n) && CARD_MASK_RE.test(n.text))
        this.signal("card_mask", "маска номера карты", n);
      this.code(n);
      ts.forEachChild(n, visit);
    };
    visit(src.sf);
  }
}

function stringSignals(c: Collector, node: ts.Node, text: string) {
  if (CARD_MASK_RE.test(text)) c.signal("card_mask", "маска номера карты", node);
  if (HEX_ADDRESS_RE.test(text)) c.signal("hex_address", "адрес криптокошелька", node);
  for (const tok of ABUSE.crypto.tokens) {
    const bare = tok.replace(/^window\./, "");
    if (text.includes(bare) && /^[\w.@/-]+$/.test(text.trim())) c.signal("crypto", tok, node, tok);
  }
  if (
    /^[\w.@/-]+$/.test(text.trim()) &&
    new RegExp(`^(${ABUSE.crypto.strings.join("|")})\\b`).test(text.trim())
  )
    c.signal("crypto", text.trim(), node, text.trim());
}

/** Spec texts by zone (abuse.yaml#patterns.scope). */
function specItems(c: Collector, spec: AppSpec, slug: string | undefined) {
  c.add(spec.app.name, "identity", "app.name", { path: "/app/name" });
  if (slug) c.add(splitIdent(slug), "identity", "slug", {});
  if (spec.app.description) c.add(spec.app.description, "text", "spec", { path: "/app/description" });
  const logo = (spec.theme as { logoFile?: string } | undefined)?.logoFile;
  if (logo)
    c.add(splitIdent(logo.replace(/^.*\//, "").replace(/\.\w+$/, "")), "identity", "logo", {
      path: "/theme/logoFile",
    });
  if (spec.compliance?.operatorName)
    c.add(spec.compliance.operatorName, "identity", "operator", { path: "/compliance/operatorName" });
  if (spec.compliance?.consentText)
    c.add(spec.compliance.consentText, "text", "spec", { path: "/compliance/consentText" });
  for (const [i, p] of (spec.pages ?? []).entries())
    c.add(p.title, "identity", "page.title", { path: `/pages/${i}/title` });
  for (const [i, r] of spec.roles.entries()) c.add(r.label, "text", "spec", { path: `/roles/${i}/label` });
  for (const [i, e] of spec.entities.entries()) {
    c.add(e.label, "text", "spec", { path: `/entities/${i}/label` });
    for (const [j, f] of e.fields.entries()) {
      const path = `/entities/${i}/fields/${j}`;
      c.add(f.label, "forms", "field.label", { path, input: { type: f.type } });
      c.add(splitIdent(f.name), "forms", "field.name", { path, input: { type: f.type } });
      for (const [k, o] of (f.enum ?? []).entries())
        c.add(o.label, "text", "spec", { path: `${path}/enum/${k}/label` });
    }
  }
  for (const [i, w] of (spec.workflows ?? []).entries()) {
    if (w.label) c.add(w.label, "text", "spec", { path: `/workflows/${i}/label` });
    for (const [j, s] of w.steps.entries()) {
      for (const [k, v] of Object.entries(s.params ?? {})) {
        if (typeof v === "string" && /\s/.test(v))
          c.add(v, "text", "template", { path: `/workflows/${i}/steps/${j}/params/${k}` });
      }
    }
  }
}

export function buildCorpus(spec: AppSpec, files: ReadonlyMap<string, string>, slug?: string): Corpus {
  const c = new Collector();
  specItems(c, spec, slug);
  const sources = parseAll(files);
  for (const src of sources) {
    if (src.area === "ui") c.ui(src);
    else c.functions(src);
  }
  return { items: c.items, signals: c.signals, externalHosts: c.externalHosts, sources };
}
