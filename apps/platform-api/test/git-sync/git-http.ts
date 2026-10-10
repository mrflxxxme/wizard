// Test oracle (V3-31): a real git smart HTTP server — `git http-backend` behind a node:http CGI bridge on 127.0.0.1,
// over bare repositories in a temp directory. Used only when the machine has git; nothing leaves the loopback.
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

export function git(cwd: string, args: string[], input?: string): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.test",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A bare repository of the real server as a code host's backend: refs and merges through git plumbing. */
export class GitBackend {
  constructor(
    readonly bare: string,
    /** <server>/<name>.git */
    readonly url: string,
    readonly defaultBranch = "main",
  ) {}

  head(branch = this.defaultBranch): string | null {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], {
      cwd: this.bare,
      encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  merge(baseBranch: string, head: string, method: "merge" | "squash", title: string): string | null {
    const base = this.head(baseBranch);
    if (
      base &&
      spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: this.bare }).status !== 0
    )
      return null;
    const tree = git(this.bare, ["rev-parse", `${head}^{tree}`]).trim();
    const parents = method === "merge" ? [...(base ? [base] : []), head] : base ? [base] : [];
    const oid = git(this.bare, [
      "commit-tree",
      tree,
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      title,
    ]).trim();
    git(this.bare, ["update-ref", `refs/heads/${baseBranch}`, oid]);
    return oid;
  }

  async handle(req: Request, path: string): Promise<Response> {
    const u = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "git-protocol", "accept"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
    return globalThis.fetch(`${this.url}${path}${u.search}`, {
      method: req.method,
      headers,
      ...(body ? { body } : {}),
    });
  }
}

export interface GitHttp {
  /** http://127.0.0.1:<port> — a repository is <url>/<name>.git */
  url: string;
  requests: { method: string; path: string; protocol: string | undefined }[];
  close(): Promise<void>;
}

/** Serves every bare repository under `root` (push allowed: http.receivepack is set per repository by the test). */
export async function startGitHttp(root: string): Promise<GitHttp> {
  const requests: GitHttp["requests"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = Buffer.concat(chunks);
      const protocol = req.headers["git-protocol"] as string | undefined;
      requests.push({ method: req.method ?? "GET", path: url.pathname, protocol });
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        REMOTE_USER: "wizard",
        REMOTE_ADDR: "127.0.0.1",
        CONTENT_TYPE: (req.headers["content-type"] as string | undefined) ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        ...(protocol ? { GIT_PROTOCOL: protocol } : {}),
      };
      const cgi = spawn("git", ["http-backend"], { env });
      const out: Buffer[] = [];
      cgi.stdout.on("data", (c: Buffer) => out.push(c));
      cgi.stderr.on("data", () => {});
      cgi.on("close", () => {
        const all = Buffer.concat(out);
        const sep = all.indexOf("\r\n\r\n");
        const head = all.subarray(0, sep).toString("latin1");
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head.split("\r\n")) {
          const i = line.indexOf(":");
          if (i < 0) continue;
          const k = line.slice(0, i).trim().toLowerCase();
          const v = line.slice(i + 1).trim();
          if (k === "status") status = Number(v.split(" ")[0]);
          else headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(sep + 4));
      });
      // git http-backend may exit before reading the body (it answers from the path alone): the write then fails with
      // EPIPE, which is not an error of the exchange — the answer comes from «close» above (CI, 10.10.2026).
      cgi.stdin.on("error", () => {});
      cgi.stdin.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
