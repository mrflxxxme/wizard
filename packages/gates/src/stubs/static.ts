// V4-18: the static pass over the built site — the TSX of its pages and sections (free code of V4-06 and the pattern
// props the composer writes), no browser: texts and props by the TypeScript AST, links against the routes and anchors
// of ui/site.json and the ids of the page files. The pattern library (ui/patterns) is shared, checked code and is not
// read. Every finding names its file, the literal and the section it sits in.
import ts from "typescript";
import {
  deadLink,
  type KnownContacts,
  phoneKey,
  placeholderOf,
  type StubFinding,
  strangeContacts,
} from "./rules.js";

/** Files the pass reads: the pages and the site's own sections. */
export const STUB_FILES_RE = /^ui\/(?:pages|sections)\/.+\.tsx$/;

/** Props and attributes that hold no visible text (and are never links). */
const NOT_TEXT = new Set([
  "className",
  "class",
  "id",
  "key",
  "src",
  "srcSet",
  "sizes",
  "type",
  "name",
  "role",
  "style",
  "variant",
  "kind",
  "icon",
  "entity",
  "field",
  "pattern",
  "placeholder",
  "mask",
  "autoComplete",
  "inputMode",
  "method",
  "target",
  "rel",
  "loading",
  "decoding",
  "fetchPriority",
  "width",
  "height",
  "testid",
  "data-testid",
  "slot",
  "route",
  "file",
  "component",
  "module",
]);
const LINK = new Set(["href", "to", "path"]);
/** Props of a card whose value repeats over the cards = one phrase for all of them. */
const CARD_TEXT = new Set(["text", "description", "lead", "body", "summary", "quote"]);
const CARD_PHOTO = new Set(["image", "photo", "img", "picture", "src"]);

export interface SiteModel {
  pages: { route: string; file?: string; sections?: { id: string }[] }[];
}

/** The routes and the anchors (section ids) of ui/site.json; null — not a v3 site. */
export function siteModel(files: ReadonlyMap<string, string>): SiteModel | null {
  const raw = files.get("ui/site.json");
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as SiteModel;
    return Array.isArray(doc.pages) ? doc : null;
  } catch {
    return null;
  }
}

const propName = (n: ts.PropertyName | ts.JsxAttributeName): string =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)
    ? n.text
    : ts.isJsxNamespacedName(n)
      ? `${n.namespace.text}:${n.name.text}`
      : n.getText();

/** Id attribute of a JSX element (a section anchor), if it is a string. */
function idOf(el: ts.JsxOpeningLikeElement): string | null {
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a) || propName(a.name) !== "id" || !a.initializer) continue;
    if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  }
  return null;
}

/** The section a node sits in: the nearest element with a string id, else header / footer by tag. */
function sectionOf(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (!open) continue;
    const id = idOf(open);
    if (id && id !== "main") return id;
    const tag = open.tagName.getText();
    if (tag === "header" || tag === "footer") return tag;
  }
  return null;
}

/** Whether a node is inside JSX (texts outside JSX — imports, hooks, logic — are not shown as such). */
const inJsx = (node: ts.Node): boolean => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent)
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return true;
  return false;
};

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/**
 * Stubs of the site's files: S01 dead links and empty click handlers, S02 placeholder texts, S03 one phrase over the
 * cards and cards without a photo among cards with one, S04 contacts the owner did not give.
 */
export function stubFindings(o: { files: ReadonlyMap<string, string>; known: KnownContacts }): StubFinding[] {
  const site = siteModel(o.files);
  const routes = site?.pages.map((p) => p.route) ?? [];
  const routeOf = new Map(site?.pages.flatMap((p) => (p.file ? [[p.file, p.route] as const] : [])) ?? []);
  const anchors = new Map<string, Set<string>>();
  for (const p of site?.pages ?? []) anchors.set(p.route, new Set((p.sections ?? []).map((s) => s.id)));
  // Ids of the page files count as anchors too (free code of V4-06 names its sections itself).
  for (const [file, route] of routeOf) {
    const src = o.files.get(file);
    if (!src) continue;
    const ids = anchors.get(route) ?? new Set<string>();
    for (const m of src.matchAll(/\bid=["'{`]+([A-Za-z][\w-]*)/g)) ids.add(m[1] as string);
    for (const m of src.matchAll(/"id"\s*:\s*"([A-Za-z][\w-]*)"/g)) ids.add(m[1] as string);
    anchors.set(route, ids);
  }

  const out: StubFinding[] = [];
  const seen = new Set<string>();
  const add = (f: StubFinding) => {
    // One contact in any spelling counts once per section.
    const lit =
      f.code === "S04" && /\d/.test(f.literal ?? "") && !(f.literal ?? "").includes("@")
        ? phoneKey(f.literal ?? "")
        : f.literal;
    const k = `${f.code}|${f.file}|${f.section}|${lit}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(f);
  };

  for (const [file, src] of o.files) {
    if (!STUB_FILES_RE.test(file)) continue;
    const route = routeOf.get(file) ?? "/";
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const base = (node: ts.Node) => ({ route, file, section: sectionOf(node) });

    const text = (node: ts.Node, value: string) => {
      const p = placeholderOf(value);
      if (p) add({ code: "S02", ...base(node), literal: short(value), message_ru: `текст-заглушка: ${p}` });
      for (const c of strangeContacts(value, o.known))
        add({ code: "S04", ...base(node), literal: c, message_ru: `контакт ${c} не из брифа` });
    };
    const link = (node: ts.Node, value: string) => {
      const why = deadLink(value, { route, routes, anchors });
      if (why) add({ code: "S01", ...base(node), literal: value || "(пусто)", message_ru: why });
      const contact = /^(?:tel|mailto):(.+)$/i.exec(value.trim())?.[1];
      if (contact) text(node, decodeURIComponent(contact));
    };

    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const v = node.text.trim();
        if (v) text(node, v);
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const parent = node.parent;
        if (ts.isJsxAttribute(parent)) {
          const name = propName(parent.name);
          if (LINK.has(name)) link(node, node.text);
          else if (!NOT_TEXT.has(name) && !name.startsWith("data-")) text(node, node.text);
        } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
          const name = propName(parent.name);
          if (LINK.has(name)) link(node, node.text);
          else if (!NOT_TEXT.has(name)) text(node, node.text);
        } else if (
          inJsx(node) &&
          !ts.isImportDeclaration(parent) &&
          !ts.isElementAccessExpression(parent) &&
          !(ts.isPropertyAssignment(parent) && parent.name === node)
        )
          text(node, node.text);
      } else if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(propName(node.name)) && node.initializer) {
        const e = ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        const empty =
          !e ||
          (e.kind === ts.SyntaxKind.Identifier && e.getText() === "undefined") ||
          ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) &&
            ts.isBlock(e.body) &&
            e.body.statements.length === 0);
        if (empty)
          add({
            code: "S01",
            ...base(node),
            literal: node.getText().slice(0, 80),
            message_ru: "кнопка с пустым обработчиком ничего не делает",
          });
      } else if (ts.isArrayLiteralExpression(node)) {
        cards(node);
      }
      ts.forEachChild(node, visit);
    };

    /** Cards (an array of 2+ object literals): one phrase over them, a photo on some and not on others. */
    const cards = (arr: ts.ArrayLiteralExpression) => {
      const items = arr.elements.filter(ts.isObjectLiteralExpression);
      if (items.length < 2 || items.length !== arr.elements.length) return;
      const props = items.map(
        (it) =>
          new Map(
            it.properties.flatMap((p) =>
              ts.isPropertyAssignment(p) ? [[propName(p.name), p.initializer] as const] : [],
            ),
          ),
      );
      for (const key of CARD_TEXT) {
        const values = props.map((m) => {
          const v = m.get(key);
          return v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) ? v.text.trim() : null;
        });
        const counts = new Map<string, number>();
        for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        for (const [v, n] of counts)
          if (n >= 2)
            add({
              code: "S03",
              ...base(arr),
              literal: short(v),
              message_ru: `одна фраза в ${n} карточках из ${items.length}`,
            });
      }
      const withPhoto = props.filter((m) => [...CARD_PHOTO].some((k) => m.has(k))).length;
      // Three cards at least, as on the page (two items are as often a split: text and photo).
      if (withPhoto > 0 && withPhoto < items.length && items.length >= 3)
        add({
          code: "S03",
          ...base(arr),
          literal: `${items.length - withPhoto} из ${items.length}`,
          message_ru: `карточки без фото: ${items.length - withPhoto} из ${items.length}, у остальных фото есть`,
        });
    };
    visit(sf);
  }
  return out;
}
