// An in-memory git server for the sync tests (V3-31): smart HTTP — protocol v2 upload-pack (ls-refs, fetch) and v0
// receive-pack with report-status over side-band-64k — on top of our own pack reader and writer. It also does what the
// client's developers do on GitHub/GitLab: commits on a branch and merges (merge commit or squash).
import {
  buildTrees,
  encodeCommit,
  type GitObject,
  type GitObjectType,
  makeObject,
  parseCommit,
  parseTree,
} from "../../src/git/objects.js";
import { readPack, writePack } from "../../src/git/pack.js";
import { FLUSH, lineText, PktReader, pkt } from "../../src/git/pktline.js";

const ZERO = "0".repeat(40);
const dev = { name: "Разработчик", email: "dev@client.example", time: 1_760_100_000, tz: "+0300" };

export class MemRepo {
  readonly objects = new Map<string, { type: GitObjectType; body: Buffer }>();
  readonly refs = new Map<string, string>();
  readonly requests: string[] = [];
  /** 503 on every request (an outage). */
  down = false;
  #clock = 0;

  constructor(readonly defaultBranch = "main") {}

  put(objs: readonly GitObject[]): void {
    for (const o of objs) this.objects.set(o.oid, { type: o.type, body: o.body });
  }

  head(branch = this.defaultBranch): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  commitOf(oid: string) {
    const o = this.objects.get(oid);
    if (o?.type !== "commit") throw new Error(`no commit ${oid}`);
    return parseCommit(o.body);
  }

  flat(treeOrCommit: string): Map<string, { oid: string; mode: string }> {
    const o = this.objects.get(treeOrCommit);
    const tree = o?.type === "commit" ? parseCommit(o.body).tree : treeOrCommit;
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string) => {
      const t = this.objects.get(oid);
      if (t?.type !== "tree") throw new Error(`no tree ${oid}`);
      for (const e of parseTree(t.body)) {
        if (e.mode === "40000") walk(e.oid, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
      }
    };
    walk(tree, "");
    return out;
  }

  file(ref: string, path: string): string | null {
    const oid = ref.length === 40 ? ref : this.head(ref);
    if (!oid) return null;
    const f = this.flat(oid).get(path);
    return f ? (this.objects.get(f.oid)?.body.toString("utf8") ?? null) : null;
  }

  /** A developer's commit on a branch: files to set (string), to delete (null) or symlinks ({link}). */
  commit(branch: string, files: Record<string, string | null | { link: string }>, message: string): string {
    const parent = this.head(branch);
    const flat = parent ? this.flat(parent) : new Map<string, { oid: string; mode: string }>();
    for (const [p, v] of Object.entries(files)) {
      if (v === null) flat.delete(p);
      else {
        const isLink = typeof v === "object";
        const blob = makeObject("blob", Buffer.from(isLink ? v.link : v, "utf8"));
        this.put([blob]);
        flat.set(p, { oid: blob.oid, mode: isLink ? "120000" : "100644" });
      }
    }
    const { root, trees } = buildTrees(flat);
    this.put(trees);
    const sig = { ...dev, time: dev.time + ++this.#clock };
    const c = makeObject(
      "commit",
      encodeCommit({ tree: root, parents: parent ? [parent] : [], author: sig, committer: sig, message }),
    );
    this.put([c]);
    this.refs.set(`refs/heads/${branch}`, c.oid);
    return c.oid;
  }

  isAncestor(a: string, b: string): boolean {
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length) {
      const x = stack.pop() as string;
      if (x === a) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      const o = this.objects.get(x);
      if (o?.type === "commit") stack.push(...parseCommit(o.body).parents);
    }
    return false;
  }

  /** Merges `head` into the base branch like a code host: null when not mergeable (the base is not in head's history). */
  merge(baseBranch: string, head: string, method: "merge" | "squash", title: string): string | null {
    const base = this.head(baseBranch);
    if (base && !this.isAncestor(base, head)) return null;
    const tree = this.commitOf(head).tree;
    const sig = { ...dev, time: dev.time + ++this.#clock };
    const parents = method === "merge" ? [...(base ? [base] : []), head] : base ? [base] : [];
    const c = makeObject(
      "commit",
      encodeCommit({ tree, parents, author: sig, committer: sig, message: title }),
    );
    this.put([c]);
    this.refs.set(`refs/heads/${baseBranch}`, c.oid);
    return c.oid;
  }

  #closure(tips: readonly string[], stop: ReadonlySet<string>): GitObject[] {
    const out = new Map<string, GitObject>();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (out.has(oid) || stop.has(oid)) continue;
      const o = this.objects.get(oid);
      if (!o) continue;
      out.set(oid, { oid, ...o });
      if (o.type === "commit") {
        const c = parseCommit(o.body);
        stack.push(c.tree, ...c.parents);
      } else if (o.type === "tree")
        for (const e of parseTree(o.body)) if (e.mode !== "160000") stack.push(e.oid);
    }
    return [...out.values()];
  }

  /** Handles <repo URL>/info/refs and the two services; `path` is what follows the repository URL. */
  async handle(req: Request, path: string): Promise<Response> {
    this.requests.push(`${req.method} ${path}`);
    if (this.down) return new Response("unavailable", { status: 503 });
    const url = new URL(req.url);
    const service = url.searchParams.get("service");
    if (req.method === "GET" && path === "/info/refs" && service === "git-upload-pack") {
      const body = Buffer.concat([
        pkt("# service=git-upload-pack\n"),
        FLUSH,
        pkt("version 2\n"),
        pkt("agent=mem/1\n"),
        pkt("ls-refs=unborn\n"),
        pkt("fetch=shallow\n"),
        pkt("object-format=sha1\n"),
        FLUSH,
      ]);
      return new Response(new Uint8Array(body), {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (req.method === "GET" && path === "/info/refs" && service === "git-receive-pack") {
      const caps = "report-status side-band-64k atomic delete-refs ofs-delta agent=mem/1";
      const lines = [...this.refs].map(([n, o], i) => pkt(`${o} ${n}${i === 0 ? `\0${caps}` : ""}\n`));
      if (lines.length === 0) lines.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
      const body = Buffer.concat([pkt("# service=git-receive-pack\n"), FLUSH, ...lines, FLUSH]);
      return new Response(new Uint8Array(body), {
        headers: { "content-type": "application/x-git-receive-pack-advertisement" },
      });
    }
    const raw = Buffer.from(await req.arrayBuffer());
    if (req.method === "POST" && path === "/git-upload-pack") {
      const r = new PktReader(raw);
      let command = "";
      const args: string[] = [];
      let inArgs = false;
      for (;;) {
        const l = r.next();
        if (!l || l.kind === "flush") break;
        if (l.kind === "delim") {
          inArgs = true;
          continue;
        }
        if (l.kind !== "data") continue;
        const t = lineText(l.data);
        if (!inArgs && t.startsWith("command=")) command = t.slice(8);
        else if (inArgs) args.push(t);
      }
      if (command === "ls-refs") {
        const head = this.head();
        const out = [
          head
            ? pkt(`${head} HEAD symref-target:refs/heads/${this.defaultBranch}\n`)
            : args.includes("unborn")
              ? pkt(`unborn HEAD symref-target:refs/heads/${this.defaultBranch}\n`)
              : Buffer.alloc(0),
          ...[...this.refs].map(([n, o]) => pkt(`${o} ${n}\n`)),
          FLUSH,
        ];
        return new Response(new Uint8Array(Buffer.concat(out)), {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        });
      }
      if (command === "fetch") {
        const wants = args.filter((a) => a.startsWith("want ")).map((a) => a.slice(5));
        const haves = args
          .filter((a) => a.startsWith("have "))
          .map((a) => a.slice(5))
          .filter((h) => this.objects.has(h));
        const have = new Set(this.#closure(haves, new Set()).map((o) => o.oid));
        const pack = writePack(this.#closure(wants, have));
        const chunks: Buffer[] = [pkt("packfile\n")];
        for (let i = 0; i < pack.byteLength; i += 65000)
          chunks.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65000)])));
        chunks.push(FLUSH);
        return new Response(new Uint8Array(Buffer.concat(chunks)), {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        });
      }
      return new Response("bad command", { status: 400 });
    }
    if (req.method === "POST" && path === "/git-receive-pack") {
      const r = new PktReader(raw);
      const cmds: { old: string; neu: string; ref: string }[] = [];
      for (;;) {
        const l = r.next();
        if (!l || l.kind === "flush") break;
        if (l.kind !== "data") continue;
        const t = lineText(l.data).split("\0")[0] as string;
        const [old, neu, ref] = t.split(" ");
        cmds.push({ old: old as string, neu: neu as string, ref: ref as string });
      }
      const rest = r.rest();
      if (rest.byteLength)
        this.put(
          await readPack(rest, {
            external: async (oids) =>
              new Map(
                oids
                  .filter((o) => this.objects.has(o))
                  .map((o) => [o, this.objects.get(o) as { type: GitObjectType; body: Buffer }]),
              ),
          }),
        );
      const lines = [pkt("unpack ok\n")];
      for (const c of cmds) {
        const cur = this.refs.get(c.ref) ?? ZERO;
        if (cur !== c.old) lines.push(pkt(`ng ${c.ref} stale info\n`));
        else if (c.neu !== ZERO && !this.objects.has(c.neu)) lines.push(pkt(`ng ${c.ref} missing object\n`));
        else {
          if (c.neu === ZERO) this.refs.delete(c.ref);
          else this.refs.set(c.ref, c.neu);
          lines.push(pkt(`ok ${c.ref}\n`));
        }
      }
      const inner = Buffer.concat([...lines, FLUSH]);
      const body = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
      return new Response(new Uint8Array(body), {
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}
