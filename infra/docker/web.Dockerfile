# syntax=docker/dockerfile:1.7
# platform-web: static build of apps/platform-web served by unprivileged nginx (BSD-2-Clause) on :8080.
# /api goes to platform-api through the ingress (infra/helm/wizard, platform host), not through this server.
# Read-only root filesystem: the chart mounts emptyDirs at /tmp, /var/cache/nginx and /etc/nginx/conf.d (the
# entrypoint renders templates/default.conf.template there with WIZARD_SYSTEMS_DOMAIN for the CSP frame-src).
ARG NODE_IMAGE=node:22.22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=10.33.0
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g --ignore-scripts "pnpm@${PNPM_VERSION}"
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store --filter "@wizard/platform-web..." \
 && pnpm --filter @wizard/platform-web build

FROM ${NGINX_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/mrflxxxme/wizard" \
      org.opencontainers.image.description="Wizard platform-web ${VERSION}"
COPY --from=build /app/apps/platform-web/dist /usr/share/nginx/html
COPY infra/docker/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY infra/docker/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
ENV WIZARD_SYSTEMS_DOMAIN=localhost:4100
USER 101
EXPOSE 8080
