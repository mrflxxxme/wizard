// G0-SEC-01: forbidden APIs of specs/quality/gates.yaml#G0.forbidden_api by area, plus limits.
import ts from "typescript";
import type { Finding } from "../report.js";
import {
  isMemberAccess,
  isValueReference,
  memberName,
  nodeLine,
  type SourceInfo,
  snippet,
  unwrap,
} from "./source.js";

/** forbidden_api.limits: function source ≤ 200 KB. */
export const FUNCTION_SOURCE_LIMIT = 200 * 1024;

const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);
/** Objects whose members must not be read by a non-literal key (forbidden_api.both). */
const COMPUTED_GUARDED = new Set([...GLOBAL_OBJECTS, "document", "navigator", "location", "Reflect"]);
/** Global names forbidden everywhere (forbidden_api.both). */
const BOTH_IDS = new Set([
  "eval",
  "Function",
  "require",
  "process",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "WebAssembly",
  "SharedArrayBuffer",
  "Atomics",
  "Reflect",
  "importScripts",
]);
/** Names that are commonly local variables: only flagged when the file declares no such name. */
const SHADOWABLE = new Set(["self", "global", "parent", "top", "opener", "name", "open"]);
const UI_GLOBAL_IDS = new Set(["parent", "top", "opener", "postMessage"]);
const UI_GLOBAL_MEMBERS = new Set(["parent", "top", "opener", "postMessage", "name", "frames"]);
const UI_ANY_MEMBERS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "opener", "postMessage"]);
const UI_FORBIDDEN_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed"]);
const DOCUMENT_MEMBERS = new Set(["write", "writeln", "cookie"]);
const STORAGE = new Set(["localStorage", "sessionStorage"]);
const DEFINERS = new Set(["query", "mutation", "action"]);
const SQL_RE =
  /\b(select\s[\s\S]*\bfrom\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b|drop\s+(table|schema|database)\b|create\s+(table|schema|function|role)\b|alter\s+(table|role|schema)\b|truncate\s+\S|grant\s+\S)/i;

const HINT_NET = "Внешние вызовы — только через ctx.connectors.* в action";
const HINT_GENERIC = "Уберите этот вызов: он запрещён в коде систем (quality/gates.yaml#G0.forbidden_api)";

export interface SecurityOptions {
  /** Names of spec fields with pii≠none (localStorage/sessionStorage rule for ui/**). */
  piiFieldNames?: ReadonlySet<string>;
}

function isStringish(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (ts.isStringLiteralLike(u) || ts.isTemplateExpression(u)) return true;
  return (
    ts.isBinaryExpression(u) &&
    u.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringish(u.left) || isStringish(u.right))
  );
}

/** Root identifier of `a.b.c` / `a[x].b` / `a.b()`. */
function rootIdentifier(e: ts.Expression): ts.Identifier | null {
  let cur = unwrap(e);
  for (;;) {
    if (isMemberAccess(cur)) cur = unwrap(cur.expression);
    else if (ts.isCallExpression(cur)) cur = unwrap(cur.expression);
    else return ts.isIdentifier(cur) ? cur : null;
  }
}

export function checkSecurity(src: SourceInfo, opts: SecurityOptions = {}): Finding[] {
  const out: Finding[] = [];
  const { sf, area, declared } = src;
  const push = (node: ts.Node, message_ru: string, fixHint = HINT_GENERIC) =>
    out.push({ message_ru, file: src.path, line: nodeLine(node), evidence: snippet(node), fixHint });
  const isGlobalObj = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    return (
      ts.isIdentifier(u) && GLOBAL_OBJECTS.has(u.text) && !(SHADOWABLE.has(u.text) && declared.has(u.text))
    );
  };
  /** `document`, `window.document`, `globalThis["navigator"]`… → the host object's name. */
  const hostObject = (e: ts.Expression): string | null => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return declared.has(u.text) && SHADOWABLE.has(u.text) ? null : u.text;
    if (isMemberAccess(u) && isGlobalObj(u.expression)) return memberName(u);
    return null;
  };
  const shadowed = (name: string) => SHADOWABLE.has(name) && declared.has(name);

  if (area === "functions" && Buffer.byteLength(src.text, "utf8") > FUNCTION_SOURCE_LIMIT) {
    out.push({
      message_ru: `Файл функции больше 200 КБ (${Math.round(Buffer.byteLength(src.text, "utf8") / 1024)} КБ)`,
      file: src.path,
      line: 1,
      fixHint: "Разделите функцию на несколько файлов или уберите встроенные данные",
    });
  }
  let usesStorage: ts.Node | null = null;
  let mentionsPii = false;

  const visit = (node: ts.Node): void => {
    if (ts.isWithStatement(node)) push(node, "Оператор with запрещён");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(node, "Динамический import() запрещён");
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "__proto__") {
      push(node, "Обращение к __proto__ запрещено");
    }
    if (ts.isStringLiteralLike(node) && opts.piiFieldNames?.has(node.text)) mentionsPii = true;

    if (ts.isIdentifier(node)) {
      if (opts.piiFieldNames?.has(node.text)) mentionsPii = true;
      if (isValueReference(node)) {
        const n = node.text;
        if (BOTH_IDS.has(n)) {
          push(
            node,
            `Запрещённый API: ${n}`,
            n === "fetch" || n.includes("Socket") || n === "XMLHttpRequest" || n === "EventSource"
              ? HINT_NET
              : HINT_GENERIC,
          );
        } else if (area === "functions" && (GLOBAL_OBJECTS.has(n) || n === "console") && !shadowed(n)) {
          push(
            node,
            n === "console" ? "console.* в функциях запрещён" : `Глобальный объект ${n} в функциях запрещён`,
            n === "console" ? "Для логов используйте ctx.log.info/warn/error" : HINT_GENERIC,
          );
        } else if (area === "ui" && UI_GLOBAL_IDS.has(n) && !shadowed(n)) {
          push(node, `Обращение к ${n} в интерфейсе запрещено`, "Интерфейс не общается с другими окнами");
        } else if (area === "ui" && STORAGE.has(n)) {
          usesStorage ??= node;
        }
      }
    }

    if (isMemberAccess(node)) {
      const name = memberName(node);
      const obj = unwrap(node.expression);
      if (name === null) {
        const host = hostObject(obj);
        if (host && COMPUTED_GUARDED.has(host))
          push(node, `Обращение к ${host}[…] по вычисляемому ключу запрещено`);
      } else {
        if (isGlobalObj(obj) && BOTH_IDS.has(name)) push(node, `Запрещённый API: ${name}`);
        if (name === "constructor" && isMemberAccess(obj) && memberName(obj) === "constructor") {
          push(node, "Цепочка constructor.constructor запрещена");
        }
        if (name === "getOwnPropertyDescriptor" || name === "getOwnPropertyDescriptors") {
          const o = ts.isIdentifier(obj) ? obj.text : "";
          if (o === "Object" || o === "Reflect") push(node, `Object.${name} запрещён`);
        }
        if (area === "ui") {
          const host = hostObject(obj);
          if (UI_ANY_MEMBERS.has(name)) push(node, `Запрещённое свойство ${name} в интерфейсе`);
          else if (isGlobalObj(obj) && UI_GLOBAL_MEMBERS.has(name)) {
            push(
              node,
              `Обращение к window.${name} в интерфейсе запрещено`,
              "Интерфейс не общается с другими окнами",
            );
          } else if (host === "document" && DOCUMENT_MEMBERS.has(name))
            push(node, `document.${name} запрещён`);
          else if (host === "navigator" && name === "sendBeacon")
            push(node, "navigator.sendBeacon запрещён", HINT_NET);
          if (STORAGE.has(name) && isGlobalObj(obj)) usesStorage ??= node;
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : isMemberAccess(callee) && isGlobalObj(callee.expression)
          ? memberName(callee)
          : null;
      const first = node.arguments[0];
      if ((calleeName === "setTimeout" || calleeName === "setInterval") && first && isStringish(first)) {
        push(node, `Строковый ${calleeName} запрещён`, "Передайте функцию, а не строку");
      }
      if (area === "ui" && calleeName === "open" && !(ts.isIdentifier(callee) && shadowed("open"))) {
        const ok =
          first !== undefined &&
          (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first)) &&
          /^\/(?![/\\])/.test(ts.isTemplateExpression(first) ? first.head.text : first.text);
        if (!ok)
          push(
            node,
            "window.open разрешён только для адресов внутри системы",
            "Используйте ссылки вида /путь",
          );
      }
      if (area === "functions" && ts.isIdentifier(callee) && /^use[A-Z0-9]/.test(callee.text)) {
        push(node, `Клиентский хук ${callee.text} в функции запрещён`, "Хуки use* работают только в ui/**");
      }
      if (area === "ui" && ts.isIdentifier(callee) && DEFINERS.has(src.sdkImports.get(callee.text) ?? "")) {
        push(
          node,
          `Определение серверной функции (${src.sdkImports.get(callee.text)}) в интерфейсе запрещено`,
          "Серверные функции живут в functions/**, интерфейс вызывает их по имени",
        );
      }
      if (area === "functions" && rootIdentifier(callee)?.text === "ctx") {
        const scan = (n: ts.Node): void => {
          if ((ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) && SQL_RE.test(n.getText())) {
            push(n, "Строка SQL в аргументах SDK запрещена", "Работайте с данными через ctx.db.<сущность>.*");
          }
          ts.forEachChild(n, scan);
        };
        for (const a of node.arguments) scan(a);
      }
    }

    if (area === "ui" && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const tag = node.tagName.getText();
      if (UI_FORBIDDEN_TAGS.has(tag)) push(node, `Тег <${tag}> в интерфейсе запрещён`);
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const an = attr.name.getText();
        if ((tag === "form" && an === "action") || an === "formAction") {
          push(attr, `Атрибут ${an} у формы запрещён`, "Отправляйте формы через useMutation");
        }
      }
    }
    if (
      area === "ui" &&
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === "dangerouslySetInnerHTML"
    ) {
      push(node, "dangerouslySetInnerHTML запрещён", "Выводите текст обычными JSX-узлами");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (usesStorage && mentionsPii) {
    push(
      usesStorage,
      "localStorage/sessionStorage в файле, который работает с персональными данными",
      "Не сохраняйте персональные данные в браузере",
    );
  }
  return out;
}
