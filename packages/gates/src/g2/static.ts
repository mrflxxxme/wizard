// Static G2 checks over spec + sources: G2-SECRET-01/02, G2-PERM-05 (public role, systemDb — sdk.md §2.3 L3-22),
// G2-TG-01 (Telegram without ПДн: spec templates via @wizard/connectors + AST taint of ctx.connectors.<tg>.*).
import { type AppSpec, SECRET_REF_RE } from "@wizard/appspec";
import { parseSecretRef, validateIntegrations } from "@wizard/connectors";
import { detect } from "@wizard/pii";
import ts from "typescript";
import { importGraph, reachable } from "../g0/imports.js";
import { nodeLine, type SourceInfo, unwrap } from "../g0/source.js";
import { fieldPiiCategory } from "../g1/seed.js";
import type { Finding } from "../report.js";
import { ABUSE, shannon } from "./patterns.js";

// ------------------------------------------------------------------------------------------------ secrets

const SECRET_RES = ABUSE.secrets.regex.map((r) => new RegExp(r, "g"));
const ENTROPY = ABUSE.secrets.entropy;
const CONTEXT_RE = new RegExp(ENTROPY.context, "i");
const CANDIDATE_RE = new RegExp(`[A-Za-z0-9+/_=.-]{${ENTROPY.minLength},}`, "g");

const maskSecret = (s: string) => `${s.slice(0, 4)}…(${s.length})`;

function scanText(text: string): { what: string; index: number }[] {
  const out: { what: string; index: number }[] = [];
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ what: `шаблон ключа ${maskSecret(m[0])}`, index: m.index });
  }
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const s = m[0];
    if (!/\d/.test(s) || !/[A-Za-z]/.test(s) || shannon(s) < ENTROPY.minBits) continue;
    const around = text.slice(Math.max(0, m.index - ENTROPY.window), m.index + s.length + ENTROPY.window);
    if (CONTEXT_RE.test(around.replace(s, " ")))
      out.push({ what: `случайная строка рядом с key/token/secret ${maskSecret(s)}`, index: m.index });
  }
  return out;
}

function walkStrings(v: unknown, path: string, out: [string, string][]) {
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) walkStrings(x, `${path}/${i}`, out);
  } else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v))
      walkStrings(x, `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, out);
}

/** G2-SECRET-01: no secrets in files and spec. */
export function secretsInCode(spec: AppSpec, files: ReadonlyMap<string, string>): Finding[] {
  const out: Finding[] = [];
  const strings: [string, string][] = [];
  walkStrings(spec, "", strings);
  for (const [path, s] of strings) {
    if (SECRET_REF_RE.test(s)) continue;
    for (const h of scanText(s))
      out.push({
        message_ru:
          "В описании системы похоже на секрет (ключ, токен или пароль) — секреты хранятся только в хранилище",
        path,
        evidence: h.what,
        fixHint: "Уберите значение и используйте ссылку secret://name",
      });
  }
  for (const [file, text] of files) {
    if (!/^(ui|functions)\//.test(file)) continue;
    for (const h of scanText(text))
      out.push({
        message_ru: "В коде похоже на секрет (ключ, токен или пароль) — секреты хранятся только в хранилище",
        file,
        line: text.slice(0, h.index).split("\n").length,
        evidence: h.what,
        fixHint: "Уберите значение из кода; секреты интеграций задаются в настройках как secret://name",
      });
  }
  return out;
}

/** G2-SECRET-02: secretRefs are secret://name; for prod each is set in the vault (existence only). */
export async function secretRefs(
  spec: AppSpec,
  env: "draft" | "prod",
  exists: ((name: string) => Promise<boolean>) | undefined,
): Promise<{ findings: Finding[]; error?: string }> {
  const out: Finding[] = [];
  const names: [string, string][] = [];
  for (const [i, integ] of (spec.integrations ?? []).entries()) {
    for (const [j, ref] of (integ.secretRefs ?? []).entries()) {
      const name = parseSecretRef(ref);
      if (!name || !SECRET_REF_RE.test(ref))
        out.push({
          message_ru: `Секрет интеграции «${integ.name}» задан не ссылкой secret://name`,
          path: `/integrations/${i}/secretRefs/${j}`,
          fixHint: "Секреты передаются только как secret://name",
        });
      else names.push([`/integrations/${i}/secretRefs/${j}`, name]);
    }
  }
  // M2-52: secrets ctx.http.fetch substitutes for a function (functions[].secretRefs).
  for (const [i, fn] of (spec.functions ?? []).entries()) {
    for (const [j, ref] of (fn.secretRefs ?? []).entries()) {
      const name = parseSecretRef(ref);
      if (name) names.push([`/functions/${i}/secretRefs/${j}`, name]);
    }
  }
  if (env !== "prod" || names.length === 0) return { findings: out };
  if (!exists) return { findings: out, error: "нет доступа к хранилищу секретов" };
  for (const [path, name] of names) {
    if (!(await exists(name)))
      out.push({
        message_ru: `Секрет «${name}» не задан — интеграция не заработает после публикации`,
        path,
        evidence: `secret://${name}: нет в хранилище`,
        fixHint: "Владелец вводит значение в настройках интеграции",
      });
  }
  return { findings: out };
}

// ------------------------------------------------------------------------------------------------ PERM-05

const DOC_METHODS = new Set(["get", "getBy", "list", "first", "paginate"]);

interface SystemDbUse {
  entity: string;
  method: string;
  file: string;
  line: number;
}

function systemDbUses(src: SourceInfo): SystemDbUse[] {
  const out: SystemDbUse[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const m = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(m)) {
        const table = unwrap(m.expression);
        if (ts.isPropertyAccessExpression(table) || ts.isElementAccessExpression(table)) {
          const holder = unwrap(table.expression);
          const holderName = ts.isIdentifier(holder)
            ? holder.text
            : ts.isPropertyAccessExpression(holder)
              ? holder.name.text
              : "";
          const entity = ts.isPropertyAccessExpression(table)
            ? table.name.text
            : ts.isStringLiteralLike(table.argumentExpression)
              ? table.argumentExpression.text
              : "*";
          if (holderName === "systemDb")
            out.push({ entity, method: m.name.text, file: src.path, line: nodeLine(n) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src.sf);
  return out;
}

/** G2-PERM-05: public role without unfiltered update/delete; public mutations/actions declare roles; systemDb. */
export function publicRole(
  spec: AppSpec,
  sources: SourceInfo[],
  files: ReadonlyMap<string, string>,
): Finding[] {
  const out: Finding[] = [];
  const pub = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  for (const [i, p] of spec.permissions.entries()) {
    if (!pub.has(p.role)) continue;
    for (const op of ["update", "delete"] as const) {
      if (!p.ops.includes(op)) continue;
      const filtered =
        p.rowFilter && Object.keys(p.rowFilter).length > 0 && (p.rowFilterOps ?? p.ops).includes(op);
      if (!filtered)
        out.push({
          message_ru: `Анонимные посетители могут ${op === "update" ? "изменять" : "удалять"} любые записи «${p.entity}»`,
          path: `/permissions/${i}`,
          evidence: `public роль ${p.role}: ${op} без rowFilter`,
          fixHint: `Уберите ${op} у роли ${p.role} или ограничьте rowFilter`,
        });
    }
  }
  const fnSources = sources.filter((s) => s.area === "functions");
  const graph = importGraph(fnSources, files);
  const uses = new Map(fnSources.map((s) => [s.path, systemDbUses(s)]));
  const piiEntities = new Set(
    spec.entities.filter((e) => e.fields.some((f) => fieldPiiCategory(f) !== "none")).map((e) => e.name),
  );
  for (const [i, f] of (spec.functions ?? []).entries()) {
    const roles = f.roles ?? [];
    if (f.public === true && f.kind !== "query" && roles.length === 0)
      out.push({
        message_ru: `Функция «${f.name}» вызывается из интерфейса, но не указано, каким ролям она доступна`,
        path: `/functions/${i}`,
        evidence: `${f.kind} public без roles`,
        fixHint: "Укажите roles у функции",
      });
    const all = [...reachable([f.file], graph)].flatMap((p) => uses.get(p) ?? []);
    if (all.length === 0) continue;
    const list = [...new Set(all.map((u) => `${u.entity}.${u.method}`))].join(", ");
    const publicCallable = f.public === true && roles.some((r) => pub.has(r));
    const reason = (f as { systemDbReason?: unknown }).systemDbReason;
    const risky = all.filter(
      (u) => DOC_METHODS.has(u.method) && (u.entity === "*" || piiEntities.has(u.entity)),
    );
    if (publicCallable && risky.length && !(typeof reason === "string" && reason.trim().length >= 10)) {
      const u = risky[0] as SystemDbUse;
      out.push({
        message_ru: `Функция «${f.name}» доступна анонимным посетителям и читает записи с ПДн в обход прав (ctx.systemDb)`,
        file: u.file,
        line: u.line,
        path: `/functions/${i}`,
        evidence: `systemDb: ${risky.map((x) => `${x.entity}.${x.method}`).join(", ")}; нет function.systemDbReason`,
        fixHint:
          "Читайте через ctx.db или верните только агрегаты (count); иначе укажите function.systemDbReason",
      });
    } else
      out.push({
        status: "pass",
        message_ru: `Функция «${f.name}» использует системный доступ к данным: ${list}`,
        path: `/functions/${i}`,
      });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ TG-01

/** Field names holding ПДн: pii≠none fields of every entity plus users contacts. */
function piiNames(spec: AppSpec): Set<string> {
  const out = new Set(["email", "phone", "display_name", "displayName"]);
  for (const e of spec.entities)
    for (const f of e.fields) if (fieldPiiCategory(f) !== "none") out.add(f.name);
  return out;
}

/** G2-TG-01: Telegram texts and ctx.connectors.<telegram>.* arguments carry no ПДн. */
export function telegramNoPii(spec: AppSpec, sources: SourceInfo[]): Finding[] {
  const out: Finding[] = [];
  for (const issue of validateIntegrations(spec)) {
    if (issue.rule !== "G2-TG-01") continue;
    out.push({ message_ru: issue.message_ru, path: issue.path, evidence: "шаблон уведомления Telegram" });
  }
  const tg = new Set((spec.integrations ?? []).filter((i) => i.connector === "telegram").map((i) => i.name));
  if (tg.size === 0) return out;
  const pii = piiNames(spec);
  for (const [wi, w] of (spec.workflows ?? []).entries()) {
    for (const [si, s] of w.steps.entries()) {
      if (s.type !== "connector" || !tg.has(String(s.params?.integration ?? ""))) continue;
      const json = JSON.stringify(s.params ?? {});
      const refs = [...json.matchAll(/\$record\.([a-z_]+)|\{\{\s*([a-z_]+)/g)].map((m) => m[1] ?? m[2]);
      const bad = refs.filter((r): r is string => !!r && pii.has(r));
      if (bad.length)
        out.push({
          message_ru: "Шаг воркфлоу отправляет в Telegram персональные данные",
          path: `/workflows/${wi}/steps/${si}`,
          evidence: `поля: ${[...new Set(bad)].join(", ")}`,
          fixHint: "В Telegram — только номер заявки и ссылка; данные человек смотрит в системе",
        });
    }
  }
  for (const src of sources.filter((s) => s.area === "functions")) {
    const tainted = new Set<string>();
    // One-level taint: variables initialised from an access to a ПДн field.
    const collect = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isIdentifier(n.name) &&
        touchesPii(n.initializer, pii)
      )
        tainted.add(n.name.text);
      if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
        const key = n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName.text : n.name.text;
        if (pii.has(key)) tainted.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(src.sf);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const m = /\.connectors\.([A-Za-z0-9_]+)\.[A-Za-z0-9_]+$/.exec(unwrap(n.expression).getText());
        if (m && tg.has(m[1] as string)) {
          const why = n.arguments.flatMap((a) => argPii(a, pii, tainted));
          if (why.length)
            out.push({
              message_ru: "Функция отправляет в Telegram персональные данные",
              file: src.path,
              line: nodeLine(n),
              evidence: `ctx.connectors.${m[1]}: ${[...new Set(why)].join(", ")}`,
              fixHint: "В Telegram — только номер заявки и ссылка; данные человек смотрит в системе",
            });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src.sf);
  }
  return out;
}

function touchesPii(e: ts.Node, pii: ReadonlySet<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(n) && pii.has(n.name.text)) hit = true;
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      pii.has(n.argumentExpression.text)
    )
      hit = true;
    ts.forEachChild(n, visit);
  };
  visit(e);
  return hit;
}

function argPii(a: ts.Node, pii: ReadonlySet<string>, tainted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && pii.has(n.name.text)) out.push(n.name.text);
    else if (ts.isShorthandPropertyAssignment(n) && (pii.has(n.name.text) || tainted.has(n.name.text)))
      out.push(n.name.text);
    else if (
      ts.isIdentifier(n) &&
      tainted.has(n.text) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
    )
      out.push(n.text);
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && detect(n.text).length > 0)
      out.push("ПДн в тексте");
    else if (ts.isTemplateExpression(n)) {
      const lit = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
      if (detect(lit).length > 0) out.push("ПДн в тексте");
    }
    ts.forEachChild(n, visit);
  };
  visit(a);
  return out;
}
