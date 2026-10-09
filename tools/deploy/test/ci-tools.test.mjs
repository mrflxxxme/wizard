// M2-06 CI helpers: image builds from images.json and short-lived deploy credentials (GitHub OIDC → OpenBao).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs as baoArgs, main as baoMain, exportLines, fetchDeployEnv } from "../bao-env.mjs";
import { baseImageArgs, buildArgs, IMAGES, main as imagesMain, mirrorRef, parseArgs } from "../images.mjs";

describe("images.mjs", () => {
  it("--mirror takes the Docker Hub base images of every Dockerfile from ECR Public; no mirror, no override", () => {
    expect(mirrorRef("node:22.22-bookworm-slim", "public.ecr.aws")).toBe(
      "public.ecr.aws/docker/library/node:22.22-bookworm-slim",
    );
    expect(mirrorRef("nginxinc/nginx-unprivileged:1.29-alpine", "public.ecr.aws")).toBe(
      "public.ecr.aws/nginx/nginx-unprivileged:1.29-alpine",
    );
    expect(mirrorRef("ghcr.io/x/y:1", "public.ecr.aws")).toBe("ghcr.io/x/y:1");
    expect(mirrorRef("node:22", "")).toBe("node:22");
    for (const img of IMAGES) {
      const args = baseImageArgs(img.dockerfile, "public.ecr.aws");
      expect(args.length, img.name).toBeGreaterThan(0);
      for (const a of args.filter((x) => x !== "--build-arg"))
        expect(a).toMatch(/^[A-Z_]+_IMAGE=public\.ecr\.aws\//);
    }
    expect(baseImageArgs(IMAGES[0].dockerfile, "")).toEqual([]);
    const lines = [];
    imagesMain(["build", "--only", "wizard-platform-web", "--mirror", "public.ecr.aws", "--dry-run"], (s) =>
      lines.push(s),
    );
    expect(lines[0]).toContain("--build-arg NGINX_IMAGE=public.ecr.aws/nginx/nginx-unprivileged:1.29-alpine");
    expect(() => parseArgs(["build", "--mirror", "bad/host"])).toThrow(/mirror/);
  });

  it("one buildx call per image, loaded locally; push goes through the Docker daemon", () => {
    const lines = [];
    imagesMain(["build", "--registry", "wizard-staging.cr.cloud.ru", "--tag", "abc123", "--dry-run"], (s) =>
      lines.push(s),
    );
    expect(lines).toHaveLength(IMAGES.length);
    expect(lines[0]).toContain("--tag wizard-staging.cr.cloud.ru/wizard-platform-api:abc123");
    expect(lines[0]).toContain("--build-arg FILTER=@wizard/platform-api");
    expect(lines[0]).toContain("--load");
    const { args, ref } = buildArgs(IMAGES[0], { registry: "192.168.10.10:30500", tag: "t", push: true });
    expect(args).toContain("--load");
    expect(ref).toBe("192.168.10.10:30500/wizard-platform-api:t");
    const pushed = [];
    imagesMain(
      [
        "build",
        "--registry",
        "192.168.10.10:30500",
        "--tag",
        "t",
        "--push",
        "--only",
        "wizard-runtime",
        "--dry-run",
      ],
      (s) => pushed.push(s),
    );
    expect(pushed).toEqual([
      expect.stringContaining("buildx build"),
      "$ docker push 192.168.10.10:30500/wizard-runtime:t",
    ]);
    expect(() => parseArgs(["build", "--tag", "bad tag"])).toThrow();
    expect(() => parseArgs(["build", "--registry", "https://x"])).toThrow();
    expect(() => imagesMain(["build", "--only", "nope", "--dry-run"], () => {})).toThrow(/unknown image/);
  });
});

describe("bao-env.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "wz-bao-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const VARS = {
    OPENBAO_ADDR: "https://bao.internal:8200",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh.example/token?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
  };
  const fakeFetch =
    (calls, secret = { CLOUDRU_IAC_KEY_SECRET: "s3cr3t\nline2", CLOUDRU_PROJECT_ID: "p" }) =>
    async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.startsWith("https://gh.example/token")) {
        expect(url).toContain("audience=openbao");
        return json({ value: "gh-jwt" });
      }
      if (url.endsWith("/v1/auth/jwt/login")) {
        expect(JSON.parse(init.body)).toEqual({ role: "wizard-deploy-staging", jwt: "gh-jwt" });
        return json({ auth: { client_token: "bao-token", lease_duration: 300 } });
      }
      if (url.endsWith("/v1/auth/token/revoke-self")) return new Response(null, { status: 204 });
      expect(init.headers["x-vault-token"]).toBe("bao-token");
      return json({ data: { data: secret } });
    };

  it("OIDC → login → one read → token revoked; values masked and exported", async () => {
    const calls = [];
    const env = join(dir, "github_env");
    const out = [];
    const orig = console.log;
    console.log = (s) => out.push(s);
    try {
      await baoMain(
        ["--role", "wizard-deploy-staging", "--path", "secret/data/wizard/staging/deploy"],
        { ...VARS, GITHUB_ENV: env },
        fakeFetch(calls),
      );
    } finally {
      console.log = orig;
    }
    expect(calls.map((c) => `${c.split(" ")[0]} ${new URL(c.split(" ")[1]).pathname}`)).toEqual([
      "GET /token",
      "POST /v1/auth/jwt/login",
      "GET /v1/secret/data/wizard/staging/deploy",
      "POST /v1/auth/token/revoke-self",
    ]);
    expect(out).toEqual(expect.arrayContaining(["::add-mask::s3cr3t", "::add-mask::line2"]));
    const written = readFileSync(env, "utf8");
    expect(written).toMatch(/^CLOUDRU_IAC_KEY_SECRET<<(WZ_[0-9a-f]+)\ns3cr3t\nline2\n\1\n/);
    // Values reach stdout only as mask commands (GitHub hides them in every later log line).
    expect(out.filter((l) => l.includes("s3cr3t") && !l.startsWith("::add-mask::"))).toEqual([]);
  });

  it("the token is revoked even when the read fails; misconfiguration is explicit", async () => {
    const calls = [];
    const failing = async (url, init) => {
      if (url.includes("/v1/secret/")) {
        calls.push("read");
        return new Response("{}", { status: 403 });
      }
      if (url.endsWith("revoke-self")) calls.push("revoke");
      return fakeFetch([])(url, init);
    };
    await expect(
      fetchDeployEnv(baoArgs(["--role", "wizard-deploy-staging", "--path", "secret/data/x"]), VARS, failing),
    ).rejects.toThrow(/403/);
    expect(calls).toEqual(["read", "revoke"]);
    await expect(
      fetchDeployEnv({ role: "r", path: "a/b", audience: "openbao" }, {}, failing),
    ).rejects.toThrow(/OPENBAO_ADDR/);
    expect(() => exportLines({ "bad-name": "x" })).toThrow(/env name/);
    expect(() => baoArgs(["--role", "Bad Role", "--path", "a/b"])).toThrow();
  });
});
