// A repository as the agent for compatible repositories sees it (V3-32): the files of one commit — path, git mode,
// size and the UTF-8 text when the file is text (binary files and files over the read limit keep their bytes only for
// the sandbox). Nothing here touches git or the network: the platform fetches the commit and builds the snapshot.

/** Largest file the agent reads as text. */
export const MAX_TEXT_FILE = 512 * 1024;

export type RepoFileMode = "100644" | "100755" | "120000" | "160000";

export interface RepoFile {
  path: string;
  mode: RepoFileMode;
  size: number;
  /** UTF-8 text; null — binary, not UTF-8, larger than MAX_TEXT_FILE, a symlink or a submodule. */
  text: string | null;
  /** The bytes (the sandbox writes them out); absent for a submodule. */
  data?: Uint8Array;
}

/** path → file, paths sorted. */
export type RepoSnapshot = ReadonlyMap<string, RepoFile>;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of a file's bytes: null for binary (a NUL in the first 8000 bytes, the rule of git), non-UTF-8 or too large. */
export function textOf(data: Uint8Array): string | null {
  if (data.byteLength > MAX_TEXT_FILE || data.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8.decode(data);
  } catch {
    return null;
  }
}

/** A snapshot from files: text (string), bytes, or {link} for a symlink / {submodule: oid} for a submodule. */
export function snapshotOf(
  files: Record<string, string | Uint8Array | { link: string } | { submodule: string } | { exec: string }>,
): RepoSnapshot {
  const out = new Map<string, RepoFile>();
  for (const path of Object.keys(files).sort()) {
    const v = files[path] as
      | string
      | Uint8Array
      | { link: string }
      | { submodule: string }
      | { exec: string };
    if (typeof v === "string") {
      const data = new TextEncoder().encode(v);
      out.set(path, { path, mode: "100644", size: data.byteLength, text: textOf(data), data });
    } else if (v instanceof Uint8Array) {
      out.set(path, { path, mode: "100644", size: v.byteLength, text: textOf(v), data: v });
    } else if ("link" in v) {
      const data = new TextEncoder().encode(v.link);
      out.set(path, { path, mode: "120000", size: data.byteLength, text: null, data });
    } else if ("exec" in v) {
      const data = new TextEncoder().encode(v.exec);
      out.set(path, { path, mode: "100755", size: data.byteLength, text: textOf(data), data });
    } else out.set(path, { path, mode: "160000", size: 0, text: null });
  }
  return out;
}

/** The snapshot with the agent's changes applied (text only; null deletes). */
export function applyChanges(
  snapshot: RepoSnapshot,
  changes: ReadonlyMap<string, string | null>,
): RepoSnapshot {
  const out = new Map(snapshot);
  for (const [path, text] of changes) {
    if (text === null) {
      out.delete(path);
      continue;
    }
    const data = new TextEncoder().encode(text);
    const mode = snapshot.get(path)?.mode === "100755" ? "100755" : "100644";
    out.set(path, { path, mode, size: data.byteLength, text, data });
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Top-level name of a path («src» of «src/App.tsx»; the file name for a root file). */
export const topOf = (path: string): string => path.split("/")[0] ?? path;

/** A path the agent may name: relative, no «.», «..», «.git» or empty segments, no backslash or NUL, ≤ 300 chars. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 300 || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** The text of a file of the snapshot, or null. */
export const readText = (s: RepoSnapshot, path: string): string | null => s.get(path)?.text ?? null;

/** package.json (or another JSON file) of the snapshot parsed; null when missing or not JSON. */
export function readJson(s: RepoSnapshot, path: string): Record<string, unknown> | null {
  const t = readText(s, path);
  if (t === null) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
