# syntax=docker/dockerfile:1.7
# Node services of Wizard (platform-api, worker, runtime, egress-proxy, acme-cloudru): one image per app, built with
#   docker build -f infra/docker/app.Dockerfile --build-arg FILTER=@wizard/runtime --build-arg APP_DIR=apps/runtime \
#     --build-arg ENTRY=src/main.ts -t <registry>/wizard-runtime:<sha> .
# The matrix of apps lives in infra/docker/images.json (CI and tools/deploy read it).
#
# Layout keeps the monorepo paths (apps read specs/ and tools/fixtures relative to the repo root, architecture.yaml
# #stack.dev_exec: packages export src/*.ts and run through tsx). Runtime stage: non-root (uid 1000), no shell tools
# needed, read-only root filesystem friendly — writable paths are /tmp (tsx cache) and /app/.data (a volume).
ARG NODE_IMAGE=node:22.22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG FILTER
ARG PNPM_VERSION=10.33.0
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN test -n "$FILTER" && npm install -g --ignore-scripts "pnpm@${PNPM_VERSION}"
WORKDIR /app
# Lockfile first: the store layer is reused while dependencies do not change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
# Only the app and its workspace dependencies (their devDependencies too: tsx runs the TypeScript sources).
# Install scripts stay limited to package.json#pnpm.onlyBuiltDependencies (L3-38).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store --filter "${FILTER}..." \
 && rm -rf .github docs infra/tofu infra/helm tools/eval/results

FROM ${NODE_IMAGE} AS runtime
ARG APP_DIR
ARG ENTRY=src/main.ts
ARG VERSION=dev
# B2-28 (gates.yaml#G1.browser.platform): CHROMIUM=1 (the worker, images.json) adds Playwright's headless Chromium and
# its system libraries — G1 of a plan build runs the goal scenarios in it, as the CI e2e job does.
ARG CHROMIUM=
LABEL org.opencontainers.image.source="https://github.com/mrflxxxme/wizard" \
      org.opencontainers.image.description="Wizard ${APP_DIR}"
ENV NODE_ENV=production \
    WIZARD_VERSION=${VERSION} \
    WIZARD_ROOT=/app \
    HOME=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build --chown=0:0 /app /app
# The Playwright version of the repo (@playwright/test of platform-api) installs its own Chromium build: the headless
# shell only, read-only for the app user.
RUN if [ -n "$CHROMIUM" ]; then \
      node /app/apps/platform-api/node_modules/@playwright/test/cli.js install --with-deps --only-shell chromium \
      && rm -rf /var/lib/apt/lists/* \
      && chmod -R a+rX /ms-playwright; \
    fi
# tsx is a devDependency of every app: --import resolves it from the app folder, so the app folder is the workdir.
# .entry.mjs pins the entry point at build time (exec-form CMD cannot expand build args).
RUN test -n "$APP_DIR" && test -f "/app/${APP_DIR}/${ENTRY}" \
 && printf 'import "./%s";\n' "${ENTRY}" > "/app/${APP_DIR}/.entry.mjs" \
 && mkdir -p /app/.data && chown 1000:1000 /app/.data
WORKDIR /app/${APP_DIR}
USER 1000:1000
# Exec form via node only: signals reach the process (SIGTERM → graceful close); no shell needed at run time.
ENTRYPOINT ["node", "--enable-source-maps", "--import", "tsx"]
CMD [".entry.mjs"]
