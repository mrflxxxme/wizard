// Smart HTTP client of git (V3-31; gitprotocol-http, gitprotocol-v2, gitprotocol-pack): ls-refs and fetch over protocol
// v2 when the server speaks it (v0 otherwise), push over receive-pack (v0 — the only version git has for push). Packs
// are written and read by pack.ts; nothing here starts a git binary. Credentials go only into the Authorization header
// of requests to the remote's own origin and never into an error message.

import { type GitObject, OID_RE } from "./objects.js";
import { type ExternalBase, type PackLimits, type PackStats, readPack, writePack } from "./pack.js";
import { DELIM, FLUSH, lineText, PktReader, pkt, readSideband } from "./pktline.js";

export const ZERO_OID = "0".repeat(40);
const AGENT = "agent=wizard-git/1";

export type GitTransportCode =
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "UNREACHABLE"
  | "PROTOCOL"
  | "REJECTED"
  | "TOO_LARGE"
  | "SERVER_ERROR";

/** A transport failure: a code and a short text that never carries a credential or a response body. */
export class GitTransportError extends Error {
  constructor(
    readonly code: GitTransportCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitTransportError";
  }
  /** 5xx, 429 and network failures are worth another try; the rest are not. */
  get retryable(): boolean {
    return this.code === "UNREACHABLE" || this.code === "SERVER_ERROR";
  }
}

export interface GitRemoteOptions {
  /** https://host/owner/repo.git */
  url: string;
  /** HTTP Basic credentials (GitHub App: x-access-token:<token>; GitLab OAuth: oauth2:<token>). */
  auth?: { username: string; password: string } | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Largest response body read (default 512 MB). */
  maxResponseBytes?: number;
  /** 2 (default) — ask for protocol v2 and fall back to v0 if the server answers v0; 0 — v0 only. */
  protocol?: 0 | 2;
  /** ofs-delta capability (default true); without it servers send REF_DELTA. */
  ofsDelta?: boolean;
  limits?: PackLimits;
  /** Called with the make-up of every fetched pack (tests). */
  onPack?: (s: PackStats) => void;
}

export interface RemoteRefs {
  /** Branch and tag refs → oid. */
  refs: Map<string, string>;
  /** The default branch HEAD points at (refs/heads/…), when the server says it; also for an empty repository. */
  head: string | null;
  protocol: 0 | 2;
  /** v0 capabilities of upload-pack, v2 capability names (ls-refs, fetch, …). */
  capabilities: Set<string>;
}

export interface RefUpdate {
  ref: string;
  /** Current remote value (null — the ref does not exist). */
  old: string | null;
  /** New value (null — delete the ref). */
  new: string | null;
}

export interface PushResult {
  ok: boolean;
  /** ref → "ok" or the server's reason. */
  refs: Map<string, string>;
}

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

export class GitRemote {
  readonly #o: GitRemoteOptions;
  readonly #fetch: typeof globalThis.fetch;
  #v2: Set<string> | null | undefined;

  constructor(o: GitRemoteOptions) {
    const u = new URL(o.url);
    if (u.username || u.password || u.search || u.hash)
      throw new Error("git remote: credentials or query in URL");
    this.#o = o;
    this.#fetch = o.fetch ?? globalThis.fetch;
  }

  #headers(extra: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "user-agent": "wizard-git/1", ...extra };
    const a = this.#o.auth;
    if (a) h.authorization = `Basic ${Buffer.from(`${a.username}:${a.password}`, "utf8").toString("base64")}`;
    return h;
  }

  async #request(
    path: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: Buffer },
  ) {
    let res: Response;
    try {
      res = await this.#fetch(`${base(this.#o.url)}${path}`, {
        method: init.method,
        headers: this.#headers(init.headers),
        ...(init.body ? { body: new Uint8Array(init.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 120_000),
      });
    } catch {
      throw new GitTransportError("UNREACHABLE", "git-сервер недоступен");
    }
    if (res.status === 401 || res.status === 403)
      throw new GitTransportError("AUTH_FAILED", "git-сервер не принял доступ", res.status);
    if (res.status === 404) throw new GitTransportError("NOT_FOUND", "репозиторий не найден", 404);
    if (res.status === 413) throw new GitTransportError("TOO_LARGE", "git-сервер не принял размер", 413);
    if (res.status === 429 || res.status >= 500)
      throw new GitTransportError("SERVER_ERROR", `git-сервер ответил ${res.status}`, res.status);
    if (!res.ok) throw new GitTransportError("PROTOCOL", `git-сервер ответил ${res.status}`, res.status);
    const max = this.#o.maxResponseBytes ?? 512 * 1024 * 1024;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max) throw new GitTransportError("TOO_LARGE", "ответ git-сервера слишком большой");
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength > max) throw new GitTransportError("TOO_LARGE", "ответ git-сервера слишком большой");
    return { body, type: res.headers.get("content-type") ?? "" };
  }

  /** Reads the `# service=…` preamble of a smart advertisement (optional for v2) and returns the reader after it. */
  #advertisement(body: Buffer, type: string, service: string): PktReader {
    if (!type.startsWith(`application/x-${service}-advertisement`))
      throw new GitTransportError("PROTOCOL", "сервер не поддерживает smart HTTP");
    const r = new PktReader(body);
    const peek = new PktReader(body);
    try {
      const first = peek.next();
      if (first?.kind === "data" && lineText(first.data) === `# service=${service}`) {
        r.next();
        const flush = r.next();
        if (flush?.kind !== "flush") throw new Error("no flush");
      }
    } catch {
      throw new GitTransportError("PROTOCOL", "неверный ответ git-сервера");
    }
    return r;
  }

  /** Parses a v0 ref advertisement (upload-pack or receive-pack). */
  #v0Refs(r: PktReader): RemoteRefs {
    const refs = new Map<string, string>();
    let caps = new Set<string>();
    let head: string | null = null;
    let headOid: string | null = null;
    let first = true;
    for (;;) {
      const line = r.next();
      if (!line || line.kind === "flush") break;
      if (line.kind !== "data") continue;
      let text = lineText(line.data);
      if (first) {
        const nul = text.indexOf("\0");
        if (nul >= 0) {
          caps = new Set(
            text
              .slice(nul + 1)
              .split(" ")
              .filter(Boolean),
          );
          text = text.slice(0, nul);
        }
        first = false;
      }
      const sp = text.indexOf(" ");
      const oid = text.slice(0, sp);
      const name = text.slice(sp + 1);
      if (!OID_RE.test(oid)) throw new GitTransportError("PROTOCOL", "неверная ссылка в ответе git-сервера");
      if (name === "capabilities^{}" || name.endsWith("^{}")) continue;
      if (name === "HEAD") headOid = oid;
      else refs.set(name, oid);
    }
    for (const c of caps) if (c.startsWith("symref=HEAD:")) head = c.slice("symref=HEAD:".length);
    if (!head && headOid)
      head = [...refs].find(([n, o]) => o === headOid && n.startsWith("refs/heads/"))?.[0] ?? null;
    return { refs, head, protocol: 0, capabilities: caps };
  }

  /** Branches and tags of the remote (upload-pack side), and where HEAD points. */
  async lsRefs(): Promise<RemoteRefs> {
    const v2 = this.#o.protocol !== 0;
    const res = await this.#request("/info/refs?service=git-upload-pack", {
      method: "GET",
      headers: v2 ? { "git-protocol": "version=2" } : {},
    });
    const r = this.#advertisement(res.body, res.type, "git-upload-pack");
    const peek = new PktReader(r.rest());
    const first = peek.next();
    if (v2 && first?.kind === "data" && lineText(first.data) === "version 2") {
      const caps = new Set<string>();
      r.next();
      for (;;) {
        const line = r.next();
        if (!line || line.kind === "flush") break;
        if (line.kind === "data") caps.add(lineText(line.data));
      }
      this.#v2 = caps;
      return this.#lsRefsV2(caps);
    }
    this.#v2 = null;
    return this.#v0Refs(r);
  }

  #capNames(caps: Set<string>): Set<string> {
    return new Set([...caps].map((c) => c.split("=")[0] as string));
  }

  #v2Command(caps: Set<string>, command: string, args: string[]): Buffer {
    const parts = [pkt(`command=${command}\n`), pkt(`${AGENT}\n`)];
    if ([...caps].some((c) => c.startsWith("object-format="))) parts.push(pkt("object-format=sha1\n"));
    parts.push(DELIM, ...args.map((a) => pkt(`${a}\n`)), FLUSH);
    return Buffer.concat(parts);
  }

  async #postUploadPack(body: Buffer, v2: boolean): Promise<Buffer> {
    const res = await this.#request("/git-upload-pack", {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
        ...(v2 ? { "git-protocol": "version=2" } : {}),
      },
      body,
    });
    return res.body;
  }

  async #lsRefsV2(caps: Set<string>): Promise<RemoteRefs> {
    const lsCap = [...caps].find((c) => c === "ls-refs" || c.startsWith("ls-refs="));
    const unborn = !!lsCap?.split("=")[1]?.split(" ").includes("unborn");
    const body = await this.#postUploadPack(
      this.#v2Command(caps, "ls-refs", [
        "symrefs",
        "peel",
        ...(unborn ? ["unborn"] : []),
        "ref-prefix HEAD",
        "ref-prefix refs/heads/",
        "ref-prefix refs/tags/",
      ]),
      true,
    );
    const r = new PktReader(body);
    const refs = new Map<string, string>();
    let head: string | null = null;
    try {
      for (;;) {
        const line = r.next();
        if (!line || line.kind === "flush") break;
        if (line.kind !== "data") continue;
        const [oid, name, ...attrs] = lineText(line.data).split(" ");
        if (!name || (oid !== "unborn" && !OID_RE.test(oid ?? ""))) throw new Error("bad ref");
        const target = attrs.find((a) => a.startsWith("symref-target:"))?.slice("symref-target:".length);
        if (name === "HEAD") head = target ?? null;
        else if (oid !== "unborn") refs.set(name, oid as string);
      }
    } catch {
      throw new GitTransportError("PROTOCOL", "неверный ответ git-сервера на ls-refs");
    }
    return { refs, head, protocol: 2, capabilities: this.#capNames(caps) };
  }

  /**
   * Fetches the objects of `wants` the remote has and we lack (`haves` — commits both sides have). Thin packs are not
   * asked for; `external` still resolves a REF_DELTA against an object we hold, should a server send one.
   */
  async fetch(
    wants: readonly string[],
    haves: readonly string[],
    external?: ExternalBase,
  ): Promise<GitObject[]> {
    const w = [...new Set(wants)].filter((x) => OID_RE.test(x));
    if (w.length === 0) return [];
    const h = [...new Set(haves)].filter((x) => OID_RE.test(x));
    if (this.#v2 === undefined) await this.lsRefs();
    const ofs = this.#o.ofsDelta !== false;
    let pack: Buffer;
    try {
      if (this.#v2) {
        const body = await this.#postUploadPack(
          this.#v2Command(this.#v2, "fetch", [
            "no-progress",
            ...(ofs ? ["ofs-delta"] : []),
            ...w.map((x) => `want ${x}`),
            ...h.map((x) => `have ${x}`),
            "done",
          ]),
          true,
        );
        const r = new PktReader(body);
        pack = Buffer.alloc(0);
        for (;;) {
          const line = r.next();
          if (!line) break;
          if (line.kind !== "data") continue;
          const text = lineText(line.data);
          if (text === "packfile") {
            pack = readSideband(r);
            break;
          }
          if (text.startsWith("ERR "))
            throw new GitTransportError("PROTOCOL", "git-сервер отказал в выдаче объектов");
          // acknowledgments / shallow-info / wanted-refs sections: skip to their end.
          for (;;) {
            const l = r.next();
            if (l?.kind !== "data") break;
          }
        }
      } else {
        const caps = ["side-band-64k", "no-progress", ...(ofs ? ["ofs-delta"] : []), AGENT];
        const lines = w.map((x, i) => pkt(`want ${x}${i === 0 ? ` ${caps.join(" ")}` : ""}\n`));
        const body = await this.#postUploadPack(
          Buffer.concat([...lines, FLUSH, ...h.map((x) => pkt(`have ${x}\n`)), pkt("done\n")]),
          false,
        );
        const r = new PktReader(body);
        pack = Buffer.alloc(0);
        for (;;) {
          const before = r.rest();
          const line = r.next();
          if (!line) break;
          if (line.kind !== "data") continue;
          const first = line.data[0];
          if (first === 1 || first === 2 || first === 3) {
            pack = readSideband(new PktReader(before));
            break;
          }
          const text = lineText(line.data);
          if (text.startsWith("ERR "))
            throw new GitTransportError("PROTOCOL", "git-сервер отказал в выдаче объектов");
        }
      }
    } catch (e) {
      if (e instanceof GitTransportError) throw e;
      throw new GitTransportError("PROTOCOL", "неверный ответ git-сервера на fetch");
    }
    if (pack.byteLength === 0) throw new GitTransportError("PROTOCOL", "git-сервер не прислал объекты");
    try {
      return await readPack(pack, {
        ...this.#o.limits,
        ...(external ? { external } : {}),
        ...(this.#o.onPack ? { onStats: this.#o.onPack } : {}),
      });
    } catch {
      throw new GitTransportError("PROTOCOL", "git-сервер прислал повреждённый пакет объектов");
    }
  }

  /** Refs of the receive-pack side (what a push compares against) with its capabilities. */
  async receiveRefs(): Promise<RemoteRefs> {
    const res = await this.#request("/info/refs?service=git-receive-pack", { method: "GET", headers: {} });
    return this.#v0Refs(this.#advertisement(res.body, res.type, "git-receive-pack"));
  }

  /**
   * Pushes ref updates with the objects they need (whole objects, version 2 pack). Atomic when the server allows it.
   * `refs` — the receive-pack advertisement read just before (receiveRefs), so the caller can pick `old` values.
   */
  async push(
    updates: readonly RefUpdate[],
    objects: readonly GitObject[],
    refs?: RemoteRefs,
  ): Promise<PushResult> {
    const adv = refs ?? (await this.receiveRefs());
    const todo = updates.filter((u) => u.old !== u.new);
    if (todo.length === 0) return { ok: true, refs: new Map() };
    const want = ["report-status", "side-band-64k", "atomic", "ofs-delta", "delete-refs", "quiet"].filter(
      (c) => adv.capabilities.has(c),
    );
    const caps = [...want.filter((c) => c !== "ofs-delta"), AGENT];
    const commands = todo.map((u, i) => {
      if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(u.ref))
        throw new Error(`git push: bad ref ${u.ref}`);
      const line = `${u.old ?? ZERO_OID} ${u.new ?? ZERO_OID} ${u.ref}`;
      return pkt(`${line}${i === 0 ? `\0${caps.join(" ")}` : ""}\n`);
    });
    const needPack = todo.some((u) => u.new !== null);
    const body = Buffer.concat([...commands, FLUSH, ...(needPack ? [writePack(objects)] : [])]);
    const res = await this.#request("/git-receive-pack", {
      method: "POST",
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
      },
      body,
    });
    const out = new Map<string, string>();
    if (!adv.capabilities.has("report-status")) return { ok: true, refs: out };
    let report: PktReader;
    try {
      report = adv.capabilities.has("side-band-64k")
        ? new PktReader(readSideband(new PktReader(res.body)))
        : new PktReader(res.body);
    } catch (e) {
      throw new GitTransportError("REJECTED", e instanceof Error ? e.message.slice(0, 300) : "push отклонён");
    }
    let unpackOk = false;
    try {
      for (;;) {
        const line = report.next();
        if (!line || line.kind === "flush") break;
        if (line.kind !== "data") continue;
        const text = lineText(line.data);
        if (text.startsWith("unpack ")) unpackOk = text === "unpack ok";
        else if (text.startsWith("ok ")) out.set(text.slice(3), "ok");
        else if (text.startsWith("ng ")) {
          const rest = text.slice(3);
          const sp = rest.indexOf(" ");
          out.set(sp < 0 ? rest : rest.slice(0, sp), sp < 0 ? "rejected" : rest.slice(sp + 1).slice(0, 200));
        }
      }
    } catch {
      throw new GitTransportError("PROTOCOL", "неверный ответ git-сервера на push");
    }
    const ok = unpackOk && todo.every((u) => out.get(u.ref) === "ok");
    return { ok, refs: out };
  }
}
