# Phase pods of the repository sandbox (V3-32; apps/platform-api/src/repo-agent/pod-sandbox.ts repoSandboxPod): Node 22
# with corepack — npm comes with Node, pnpm and yarn are shims that corepack resolves per repository (the version of
# package.json#packageManager is downloaded in the install phase into the workspace, /work/cache/corepack). Debian's
# coreutils (timeout, du), tar, gzip and findutils serve the restore and save steps. Non-root (uid 10001 as in
# repoSandboxPod()), read-only root filesystem at run time: /work and /tmp are volumes. Built by
# .github/workflows/images.yml like every image of infra/docker/images.json.
ARG NODE_IMAGE=node:22.22-bookworm-slim

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/mrflxxxme/wizard" \
      org.opencontainers.image.description="Wizard repository sandbox (Node 22, corepack)"
# The image's yarn 1 is replaced by corepack's shim (it honours packageManager, yarn 1 and berry alike).
RUN rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && corepack enable pnpm yarn \
 && groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --home-dir /work/home --no-create-home --shell /usr/sbin/nologin sandbox \
 && mkdir -p /work && chown 10001:10001 /work \
 && node --version && npm --version && corepack --version \
 && for b in timeout tar gzip du xargs pnpm yarn; do command -v "$b" || exit 1; done
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    NEXT_TELEMETRY_DISABLED=1
USER 10001:10001
# Not under /work: a missing working directory inside a volume would be created by the runtime as root, before the
# restore step (uid 10001) fills the workspace. The run step sets /work/repo itself once it exists.
WORKDIR /
CMD ["node", "--version"]
