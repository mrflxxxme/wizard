// Builder context (agents/builder.yaml#context): cacheable system prefix, relevant files, collapsed history with
// hysteresis (max_chars → collapse down to min_chars), one-line abbreviations of collapsed tool results.
import type { LlmMessage, ToolCall } from "@wizard/llm";

export const MAX_CHARS = 65536;
export const MIN_CHARS = 8192;
export const RELEVANT_MAX_FILES = 16;
export const RELEVANT_MAX_BYTES = 8192;

type Rec = Record<string, unknown>;
const size = (m: LlmMessage) => JSON.stringify(m).length;

/** «{tool}: …» one-liners (builder.yaml#context.collapse.abbreviations). */
export function abbreviate(call: ToolCall, result: unknown): string {
  const args = (call.args ?? {}) as Rec;
  const r = (result ?? {}) as Rec;
  const err = r.ok === false ? ((r.error ?? {}) as Rec) : null;
  const code = err ? String(err.code ?? "ERROR") : "";
  switch (call.name) {
    case "apply_ops": {
      if (err) {
        const issues = Array.isArray(err.issues) ? (err.issues as Rec[]) : [];
        return `apply_ops: ошибка ${code} в ${String(issues[0]?.path ?? "/")}`;
      }
      const ops = Array.isArray(args.ops) ? (args.ops as Rec[]) : [];
      const types = [...new Set(ops.map((o) => String(o.op)))].slice(0, 3).join(", ");
      return `apply_ops v${String(args.expectedVersion)}→v${String(r.version)}: ${ops.length} операций (${types})`;
    }
    case "write_file":
      if (err) break;
      return `записан ${String(args.path)} (${Math.max(1, Math.round(Number(r.bytes ?? 0) / 1024))} КБ)`;
    case "read_file":
      if (err) break;
      return `прочитан ${String(args.path)}`;
    case "run_gate": {
      if (err) break;
      const failed = Array.isArray(r.failed) ? (r.failed as Rec[]) : [];
      return r.passed
        ? `${String(args.level)}: passed`
        : `${String(args.level)}: упало ${failed.length}: ${failed.map((f) => String(f.id)).join(", ")}`;
    }
  }
  return `${call.name}: ${err ? `ошибка ${code}` : "ok"}`;
}

export interface RelevantFile {
  path: string;
  content: string;
}

/** Outline of a file that does not fit the relevant-files budget: exports and signatures + line count. */
export function outline(path: string, content: string): string {
  const lines = content.split("\n");
  const sig = lines
    .filter((l) => /^(export\s|(async\s+)?function\s|const\s+\w+\s*=\s*(async\s*)?\()/.test(l))
    .map((l) => (l.length > 120 ? `${l.slice(0, 119)}…` : l));
  return `// ${path}: ${lines.length} строк (outline; полный текст — read_file)\n${sig.join("\n")}`;
}

export class BuilderContext {
  readonly staticPrompt: string;
  session = "";
  #relevant = "";
  #history: LlmMessage[] = [];
  #boundary = 0;
  #summary: string[] = [];
  #pinned: string | null = null;
  #touch = new Map<string, number>();
  #tick = 0;
  #priority = new Set<string>();
  shifts = 0;

  constructor(
    staticPrompt: string,
    readonly maxChars = MAX_CHARS,
    readonly minChars = MIN_CHARS,
  ) {
    this.staticPrompt = staticPrompt;
  }

  push(...messages: LlmMessage[]): void {
    this.#history.push(...messages);
  }

  /** Marks a file as touched (write/read) for the LRU of relevant files. */
  touch(path: string): void {
    this.#touch.set(path, ++this.#tick);
  }

  /** Files mentioned in failed checks: first in the relevant files. */
  setPriority(paths: Iterable<string>): void {
    this.#priority = new Set(paths);
  }

  /** The last gate report is never collapsed away (never_collapse). */
  pinGateReport(text: string): void {
    this.#pinned = text;
  }

  get history(): readonly LlmMessage[] {
    return this.#history;
  }

  tailChars(): number {
    return this.#history.slice(this.#boundary).reduce((s, m) => s + size(m), 0);
  }

  /** Collapses the history when the tail exceeds maxChars; returns true on a boundary shift. */
  async maybeCollapse(read: (path: string) => Promise<string | null>): Promise<boolean> {
    if (this.tailChars() <= this.maxChars) return false;
    const starts: number[] = [];
    for (let i = this.#boundary; i < this.#history.length; i++)
      if (this.#history[i]?.role !== "tool") starts.push(i);
    let next = starts.at(-1) ?? this.#boundary;
    for (const s of starts) {
      const tail = this.#history.slice(s).reduce((acc, m) => acc + size(m), 0);
      if (tail <= this.minChars) {
        next = s;
        break;
      }
    }
    if (next <= this.#boundary) return false;
    this.#summary.push(...this.#summarize(this.#boundary, next));
    this.#boundary = next;
    this.shifts += 1;
    await this.refreshRelevant(read);
    return true;
  }

  #summarize(from: number, to: number): string[] {
    const out: string[] = [];
    const results = new Map<string, unknown>();
    for (const m of this.#history.slice(from, to))
      if (m.role === "tool") results.set(m.toolCallId, m.content);
    for (const m of this.#history.slice(from, to)) {
      if (m.role === "user") out.push(`Пользователь: ${firstLine(m.content)}`);
      else if (m.role === "assistant") {
        if (m.content) out.push(`Строитель: ${firstLine(m.content)}`);
        for (const c of m.toolCalls ?? []) out.push(abbreviate(c, results.get(c.id)));
      }
    }
    return out;
  }

  async refreshRelevant(read: (path: string) => Promise<string | null>): Promise<void> {
    const byRecency = [...this.#touch].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    const paths = [...new Set([...this.#priority, ...byRecency])].slice(0, RELEVANT_MAX_FILES);
    const parts: string[] = [];
    let budget = RELEVANT_MAX_BYTES;
    for (const path of paths) {
      const content = await read(path);
      if (content === null) continue;
      const bytes = Buffer.byteLength(content);
      if (bytes <= budget) {
        parts.push(`// ${path}\n${content}`);
        budget -= bytes;
      } else parts.push(outline(path, content));
    }
    this.#relevant = parts.length ? `Актуальные файлы:\n\n${parts.join("\n\n")}` : "";
  }

  render(): LlmMessage[] {
    const out: LlmMessage[] = [
      { role: "system", content: this.staticPrompt },
      { role: "system", content: this.session },
    ];
    if (this.#relevant) out.push({ role: "user", content: this.#relevant });
    if (this.#summary.length > 0) {
      const tail = this.#history.slice(this.#boundary);
      const lastUser = this.#history.findLast((m) => m.role === "user");
      const extra: string[] = [];
      if (this.#pinned && !tail.some((m) => m.role === "user" && m.content === this.#pinned))
        extra.push(`Последний отчёт проверок:\n${this.#pinned}`);
      if (lastUser && !tail.includes(lastUser) && lastUser.content !== this.#pinned)
        extra.push(`Последнее сообщение пользователя:\n${lastUser.content}`);
      out.push({
        role: "user",
        content: [`Свёрнутая история:`, ...this.#summary, ...extra].join("\n"),
      });
    }
    out.push(...this.#history.slice(this.#boundary));
    return out;
  }
}

function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 200 ? `${l.slice(0, 199)}…` : l;
}
