#!/usr/bin/env node
// Builds the images of infra/docker/images.json (M2-06):
//   node tools/deploy/images.mjs build [--registry <host>] [--tag <sha>] [--push] [--only name,…] [--mirror <host>]
//                                     [--dry-run]
// Without --push the images stay local (CI job `images` checks the Dockerfiles and makes per-image SBOMs);
// with --push they go to the environment's registry (tools/deploy/infra.mjs --build-images on the self-hosted runner):
// the in-cluster registry of a k3s environment over the VPC (plain HTTP: list it in the runner's Docker
// insecure-registries) or a managed registry after `docker login`. Images are loaded into the local Docker first and
// pushed by the daemon, so its registry settings apply. --mirror public.ecr.aws takes the Docker Hub base images
// (the `ARG *_IMAGE=` defaults of the Dockerfiles) from the ECR Public mirror of the official images: GitHub-hosted
// runners hit Docker Hub's anonymous pull limit (429).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./infra.mjs";

export const IMAGES = JSON.parse(readFileSync(join(ROOT, "infra/docker/images.json"), "utf8")).images;

export function parseArgs(argv) {
  const [command = "build", ...rest] = argv;
  const o = {
    command,
    registry: "wizard.local",
    tag: "dev",
    push: false,
    only: null,
    mirror: "",
    dryRun: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--registry") o.registry = rest[++i] ?? "";
    else if (a === "--tag") o.tag = rest[++i] ?? "";
    else if (a === "--push") o.push = true;
    else if (a === "--only") o.only = (rest[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--mirror") o.mirror = rest[++i] ?? "";
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (command !== "build") throw new Error("command: build");
  if (!/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/.test(o.registry)) throw new Error("bad --registry");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(o.tag)) throw new Error("bad --tag");
  if (o.mirror && !/^[a-z0-9.-]+(:\d+)?$/.test(o.mirror)) throw new Error("bad --mirror");
  return o;
}

/** Docker Hub repositories outside `library/` and their path on ECR Public. */
const ECR_PATHS = { "nginxinc/nginx-unprivileged": "nginx/nginx-unprivileged" };

/** A Docker Hub reference on the mirror (official images under docker/library/); other registries stay as they are. */
export function mirrorRef(ref, mirror) {
  if (!mirror) return ref;
  const [first, ...rest] = ref.split("/");
  if (rest.length > 0 && /[.:]/.test(first)) return ref;
  if (rest.length === 0) return `${mirror}/docker/library/${ref}`;
  const [repo, tag = ""] = ref.split(/(?=[:@])/);
  const path = ECR_PATHS[repo];
  return path ? `${mirror}/${path}${tag}` : ref;
}

/** `--build-arg NAME=<mirrored ref>` for each `ARG *_IMAGE=<ref>` default of a Dockerfile. */
export function baseImageArgs(dockerfile, mirror) {
  if (!mirror) return [];
  const text = readFileSync(join(ROOT, dockerfile), "utf8");
  const args = [];
  for (const m of text.matchAll(/^ARG\s+([A-Z0-9_]+_IMAGE)=(\S+)\s*$/gm)) {
    const to = mirrorRef(m[2], mirror);
    if (to !== m[2]) args.push("--build-arg", `${m[1]}=${to}`);
  }
  return args;
}

/** `docker buildx build` argv of one image (context = repo root; always --load, the daemon pushes). */
export function buildArgs(img, o) {
  const ref = `${o.registry}/${img.name}:${o.tag}`;
  const args = ["buildx", "build", "--file", img.dockerfile, "--tag", ref, "--build-arg", `VERSION=${o.tag}`];
  for (const [k, v] of Object.entries(img.args ?? {})) args.push("--build-arg", `${k}=${v}`);
  args.push(...baseImageArgs(img.dockerfile, o.mirror));
  args.push("--label", `org.opencontainers.image.revision=${o.tag}`);
  args.push("--load", ".");
  return { ref, args };
}

export function main(argv = process.argv.slice(2), log = (s) => console.log(s)) {
  const o = parseArgs(argv);
  const images = o.only ? IMAGES.filter((i) => o.only.includes(i.name)) : IMAGES;
  if (o.only && images.length !== o.only.length)
    throw new Error(`unknown image in --only: ${o.only.join(",")}`);
  for (const img of images) {
    const { ref, args } = buildArgs(img, o);
    log(`$ docker ${args.join(" ")}`);
    if (o.push) log(`$ docker push ${ref}`);
    if (o.dryRun) continue;
    const r = spawnSync("docker", args, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
    });
    if (r.status !== 0) throw new Error(`build of ${ref} failed`);
    if (o.push) {
      const p = spawnSync("docker", ["push", ref], { cwd: ROOT, stdio: "inherit" });
      if (p.status !== 0) throw new Error(`push of ${ref} failed`);
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`images: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
