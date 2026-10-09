// V3-31 transport: pkt-lines, packfiles (whole objects, OFS_DELTA, REF_DELTA, thin bases, broken packs) and the smart
// HTTP client. A real `git http-backend` (when the machine has git) is the oracle: what we push passes `git fsck`, and
// what git itself pushed (with deltas after `git repack`) comes back through protocol v2 and v0 byte-exact.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildTrees,
  encodeCommit,
  type GitObject,
  makeObject,
  parseCommit,
  parseTree,
} from "../src/git/objects.js";
import { applyDelta, encodeDelta, type PackStats, readPack, writePack } from "../src/git/pack.js";
import { DELIM, FLUSH, PktReader, pkt, readSideband } from "../src/git/pktline.js";
import { GitRemote, GitTransportError } from "../src/git/transport.js";
import { git, HAS_GIT, startGitHttp } from "./git-sync/git-http.js";

const sig = { name: "Wizard", email: "noreply@borntobuild.ru", time: 1_760_000_000, tz: "+0300" };

function commitOf(files: Record<string, string>, parents: string[], message: string) {
  const blobs = Object.entries(files).map(([p, c]) => [p, makeObject("blob", Buffer.from(c))] as const);
  const { root, trees } = buildTrees(new Map(blobs.map(([p, b]) => [p, { oid: b.oid }])));
  const commit = makeObject(
    "commit",
    encodeCommit({ tree: root, parents, author: sig, committer: sig, message }),
  );
  return { commit, objects: [...blobs.map(([, b]) => b), ...trees, commit] as GitObject[] };
}

/** A pack written by hand: entries as given (raw type code + payload), for deltas and broken input. */
function rawPack(
  entries: { type: number; data: Buffer; prefix?: Buffer }[],
  o: { badSum?: boolean } = {},
): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [head];
  for (const e of entries) {
    const size = e.data.byteLength;
    const bytes: number[] = [];
    let b = (e.type << 4) | (size & 15);
    let rest = size >> 4;
    while (rest) {
      bytes.push(b | 0x80);
      b = rest & 0x7f;
      rest >>= 7;
    }
    bytes.push(b);
    parts.push(Buffer.from(bytes), e.prefix ?? Buffer.alloc(0), deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  const sum = createHash("sha1").update(body).digest();
  if (o.badSum) sum[0] = (sum[0] as number) ^ 1;
  return Buffer.concat([body, sum]);
}

const ofsPrefix = (distance: number): Buffer => {
  const bytes = [distance & 0x7f];
  let d = distance >> 7;
  while (d) {
    d -= 1;
    bytes.unshift(0x80 | (d & 0x7f));
    d >>= 7;
  }
  return Buffer.from(bytes);
};

describe("pkt-line", () => {
  test("encode, flush, delim and side-band", () => {
    expect(pkt("a\n").toString("latin1")).toBe("0006a\n");
    const body = Buffer.concat([
      pkt("x"),
      DELIM,
      pkt(Buffer.from([1, 0x50, 0x41])),
      pkt(Buffer.from([2, 0x2e])),
      FLUSH,
    ]);
    const r = new PktReader(body);
    expect(r.next()).toMatchObject({ kind: "data" });
    expect(r.next()).toEqual({ kind: "delim" });
    expect(readSideband(r).toString("latin1")).toBe("PA");
    expect(r.done).toBe(true);
    expect(() => new PktReader(Buffer.from("00zz")).next()).toThrow(/bad length/);
    expect(() => new PktReader(Buffer.from("0009ab")).next()).toThrow(/truncated/);
    expect(() =>
      readSideband(new PktReader(Buffer.concat([pkt(Buffer.from([3, 0x6e, 0x6f])), FLUSH]))),
    ).toThrow(/remote: no/);
  });
});

describe("packfile", () => {
  test("whole objects round trip, hashes match, the empty pack is valid", async () => {
    const { objects } = commitOf(
      { "ui/Home.tsx": "export default 1;\n", "assets/logo.png": "\0PNG" },
      [],
      "Сборка",
    );
    const back = await readPack(writePack(objects));
    expect(back.map((o) => o.oid).sort()).toEqual(objects.map((o) => o.oid).sort());
    expect(await readPack(writePack([]))).toEqual([]);
  });

  test("OFS_DELTA and REF_DELTA chains, a thin base from outside the pack", async () => {
    const v1 = Buffer.from(`${"export const rows = [\n".repeat(40)}first\n`);
    const v2 = Buffer.from(`${"export const rows = [\n".repeat(40)}second line\n`);
    const v3 = Buffer.from(`header\n${v2.toString()}tail\n`);
    expect(applyDelta(v1, encodeDelta(v1, v2)).equals(v2)).toBe(true);
    const b1 = makeObject("blob", v1);
    const b3 = makeObject("blob", v3);
    // entry 0: v1 whole; entry 1: v2 as OFS_DELTA on 0; entry 2: v3 as REF_DELTA on v2 (a delta itself).
    const e0 = { type: 3, data: v1 };
    const head0 = 12;
    const sizeHeader = (n: number) => {
      let c = 1;
      for (let r = n >> 4; r; r >>= 7) c++;
      return c;
    };
    const len0 = sizeHeader(v1.byteLength) + deflateSync(v1).byteLength;
    const d12 = encodeDelta(v1, v2);
    const e1 = { type: 6, data: d12, prefix: ofsPrefix(head0 + len0 - head0) };
    const v2oid = makeObject("blob", v2).oid;
    const e2 = { type: 7, data: encodeDelta(v2, v3), prefix: Buffer.from(v2oid, "hex") };
    let stats: PackStats | undefined;
    const objs = await readPack(rawPack([e0, e1, e2]), { onStats: (s) => (stats = s) });
    expect(objs.map((o) => o.oid)).toEqual([b1.oid, v2oid, b3.oid]);
    expect(stats).toMatchObject({ objects: 3, ofsDeltas: 1, refDeltas: 1, external: 0 });

    // Thin pack: the base is only on our side.
    const thin = rawPack([{ type: 7, data: encodeDelta(v1, v2), prefix: Buffer.from(b1.oid, "hex") }]);
    await expect(readPack(thin)).rejects.toThrow(/delta base missing/);
    const got = await readPack(thin, {
      external: async (oids) =>
        new Map(oids.filter((x) => x === b1.oid).map((x) => [x, { type: "blob", body: v1 }])),
    });
    expect(got[0]?.oid).toBe(v2oid);
  });

  test("broken packs are refused: checksum, header, size, zlib bomb limit, bad delta", async () => {
    const ok = rawPack([{ type: 3, data: Buffer.from("x") }]);
    await expect(readPack(rawPack([{ type: 3, data: Buffer.from("x") }], { badSum: true }))).rejects.toThrow(
      /checksum/,
    );
    await expect(readPack(Buffer.concat([Buffer.from("PACX"), ok.subarray(4)]))).rejects.toThrow(/header/);
    await expect(readPack(ok.subarray(0, ok.byteLength - 1))).rejects.toThrow();
    const big = rawPack([{ type: 3, data: Buffer.alloc(1_000_000) }]);
    await expect(readPack(big, { maxObjectBytes: 1000 })).rejects.toThrow(/too large/);
    await expect(readPack(big, { maxTotalBytes: 1000 })).rejects.toThrow(/too large/);
    const bad = rawPack([
      { type: 3, data: Buffer.from("base") },
      { type: 6, data: Buffer.from([4, 9, 0x80 | 0x01 | 0x10, 0, 9]), prefix: ofsPrefix(17) },
    ]);
    await expect(readPack(bad)).rejects.toThrow();
  });
});

describe.skipIf(!HAS_GIT)("smart HTTP against git http-backend (oracle)", () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startGitHttp>>;
  let bare: string;
  let url: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wz-git-http-"));
    server = await startGitHttp(dir);
    bare = join(dir, "repo.git");
    git(dir, ["init", "--bare", "-q", "-b", "main", bare]);
    git(bare, ["config", "http.receivepack", "true"]);
    url = `${server.url}/repo.git`;
  });
  afterAll(async () => {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let first: string;

  test("push into an empty repository: refs, report-status, git fsck accepts the objects", async () => {
    const remote = new GitRemote({ url });
    const refs = await remote.lsRefs();
    expect(refs.refs.size).toBe(0);
    const c = commitOf(
      { "ui/Home.tsx": "export default function Home() { return null; }\n", "AGENTS.md": "# Система\n" },
      [],
      "Сборка: первая",
    );
    const res = await remote.push([{ ref: "refs/heads/main", old: null, new: c.commit.oid }], c.objects);
    expect(res).toEqual({ ok: true, refs: new Map([["refs/heads/main", "ok"]]) });
    first = c.commit.oid;
    git(bare, ["fsck", "--strict", "--no-dangling"]);
    expect(git(bare, ["rev-parse", "main"]).trim()).toBe(first);
    expect(git(bare, ["show", "main:ui/Home.tsx"])).toContain("function Home");
  });

  test("git pushes deltas; v2 fetch reads OFS_DELTA, v0 without ofs-delta reads REF_DELTA, both byte-exact", async () => {
    const work = join(dir, "work");
    git(dir, ["clone", "-q", bare, work]);
    const big = Array.from({ length: 400 }, (_, i) => `export const row${i} = "значение ${i}";`).join("\n");
    for (let i = 0; i < 4; i++) {
      await writeFile(join(work, "ui", "Rows.tsx"), `${big}\n// правка ${i}\n`);
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", `Правка разработчика ${i}`]);
    }
    git(work, ["push", "-q", "origin", "main"]);
    git(bare, ["repack", "-adfq", "--depth=50", "--window=50"]);
    const head = git(bare, ["rev-parse", "main"]).trim();

    let v2stats: PackStats | undefined;
    const v2 = new GitRemote({ url, onPack: (s) => (v2stats = s) });
    const refs = await v2.lsRefs();
    expect(refs.protocol).toBe(2);
    expect(refs.head).toBe("refs/heads/main");
    expect(refs.refs.get("refs/heads/main")).toBe(head);
    const objs = await v2.fetch([head], []);
    expect(v2stats?.ofsDeltas).toBeGreaterThan(0);
    const all = git(bare, ["rev-list", "--objects", "main"])
      .trim()
      .split("\n")
      .map((l) => l.split(" ")[0]);
    expect(new Set(objs.map((o) => o.oid))).toEqual(new Set(all));
    for (const o of objs) expect(git(bare, ["cat-file", "-t", o.oid]).trim()).toBe(o.type);
    const rows = objs.find((o) => o.type === "blob" && o.body.toString().includes("правка 3"));
    expect(rows?.body.toString()).toBe(git(bare, ["show", "main:ui/Rows.tsx"]));

    let v0stats: PackStats | undefined;
    const v0 = new GitRemote({ url, protocol: 0, ofsDelta: false, onPack: (s) => (v0stats = s) });
    expect((await v0.lsRefs()).protocol).toBe(0);
    const objs0 = await v0.fetch([head], []);
    expect(v0stats?.refDeltas).toBeGreaterThan(0);
    expect(v0stats?.ofsDeltas).toBe(0);
    expect(new Set(objs0.map((o) => o.oid))).toEqual(new Set(all));
    expect(server.requests.some((r) => r.protocol === "version=2")).toBe(true);

    // Incremental: with our first commit as a have, the server leaves it (and its tree) out.
    const inc = await v2.fetch([head], [first]);
    expect(inc.some((o) => o.oid === first)).toBe(false);
    expect(inc.length).toBeLessThan(objs.length);

    // A commit on top of what we fetched goes back and git accepts it.
    const tip = objs.find((o) => o.oid === head) as GitObject;
    const tree = parseTree((objs.find((o) => o.oid === parseCommit(tip.body).tree) as GitObject).body);
    expect(tree.map((e) => e.name).sort()).toEqual(["AGENTS.md", "ui"]);
    const next = commitOf({ "ui/Home.tsx": "export default 2;\n" }, [head], "Правка: из Wizard");
    const pushed = await v2.push(
      [{ ref: "refs/heads/wizard/sys/2", old: null, new: next.commit.oid }],
      next.objects,
    );
    expect(pushed.ok).toBe(true);
    git(bare, ["fsck", "--strict", "--no-dangling"]);
    expect(git(bare, ["log", "--format=%s", "-1", "wizard/sys/2"]).trim()).toBe("Правка: из Wizard");
  });

  test("a stale old value is rejected by the server; an unknown repository is NOT_FOUND", async () => {
    const remote = new GitRemote({ url });
    const c = commitOf({ "x.txt": "x" }, [], "x");
    const res = await remote.push([{ ref: "refs/heads/main", old: first, new: c.commit.oid }], c.objects);
    expect(res.ok).toBe(false);
    expect(res.refs.get("refs/heads/main")).not.toBe("ok");
    await expect(new GitRemote({ url: `${server.url}/nope.git` }).lsRefs()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(new GitRemote({ url: "http://127.0.0.1:1/x.git" }).lsRefs()).rejects.toBeInstanceOf(
      GitTransportError,
    );
  });
});
