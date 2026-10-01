// Minimal syntax highlighting for the read-only «Код» tab (S-code, D14): a TS/TSX/JSON/CSS tokenizer producing
// text tokens only — the viewer renders them as React text nodes, never as HTML (L3-17).

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "tag";
export interface Token {
  k: TokenKind;
  v: string;
}

const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue default delete do else enum export extends false " +
    "finally for from function if implements import in instanceof interface let new null of return satisfies " +
    "static super switch this throw true try type typeof undefined var void while yield"
  ).split(" "),
);

// One alternation, first match wins: comments, strings, numbers, JSX tag names, identifiers, anything else.
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(<\/?[A-Za-z][\w.]*)|([A-Za-z_$][\w$]*)|([\s\S])/g;

/** Tokens of a whole file split into lines (multi-line comments and template strings keep their kind). */
export function highlightLines(source: string): Token[][] {
  const lines: Token[][] = [[]];
  const push = (k: TokenKind, v: string) => {
    const parts = v.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1] as Token[];
      const last = line[line.length - 1];
      if (last && last.k === k) last.v += part;
      else line.push({ k, v: part });
    });
  };
  for (const m of source.matchAll(TOKEN)) {
    if (m[1] !== undefined) push("comment", m[1]);
    else if (m[2] !== undefined) push("string", m[2]);
    else if (m[3] !== undefined) push("number", m[3]);
    else if (m[4] !== undefined) push("tag", m[4]);
    else if (m[5] !== undefined) push(KEYWORDS.has(m[5]) ? "keyword" : "plain", m[5]);
    else push("plain", m[0]);
  }
  return lines;
}
