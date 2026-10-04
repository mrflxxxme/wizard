# syntax=docker/dockerfile:1.7
# Ops image of the pilot's self-managed database (docs/ops/deploy.md «Пилот», platform/deploy.yaml#pilot.postgres):
# PostgreSQL 16 (PostgreSQL License) + WAL-G (Apache-2.0) for continuous archiving to S3 + rclone (MIT) for the
# encrypted copy of the shared .data volume + Node (MIT) running infra/postgres/pg-ops.mjs (monitor, base backup,
# restore drill, bootstrap of a lost volume). Infrastructure outside the product bundle (THIRD_PARTY_NOTICES.md).
# Downloads are pinned by version and sha256; nothing secret is baked in (S3 keys, the WAL-G key and the database
# password come from the Secret wizard-postgres at run time).
ARG POSTGRES_IMAGE=postgres:16.13-bookworm
ARG NODE_IMAGE=node:22.22-bookworm-slim
ARG TOOLS_IMAGE=debian:bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${TOOLS_IMAGE} AS tools
# WAL-G release for PostgreSQL built on Ubuntu 22.04 (glibc 2.35 ≤ bookworm 2.36; links only libc/libm).
ARG WALG_VERSION=v3.0.9
ADD --checksum=sha256:4f03ee4679db7f660bfd1b2b8291ac5df247cd2ec48074b60c112f4897299f24 \
  https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-amd64.tar.gz /tmp/wal-g.tar.gz
ARG RCLONE_VERSION=v1.75.1
ADD --checksum=sha256:09c9f7606ed9e31eecc1eec26a89992cf2931a8d2d1a5f0ae2bb1c11630ffb15 \
  https://github.com/rclone/rclone/releases/download/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-amd64.deb /tmp/rclone.deb
RUN mkdir -p /out \
 && tar -xzf /tmp/wal-g.tar.gz -C /tmp \
 && install -m 0755 /tmp/wal-g-pg-22.04-amd64 /out/wal-g \
 && dpkg-deb -x /tmp/rclone.deb /tmp/rclone \
 && install -m 0755 /tmp/rclone/usr/bin/rclone /out/rclone

FROM ${POSTGRES_IMAGE}
# The official image purges ca-certificates after fetching gosu; WAL-G and rclone (Go) verify S3 TLS against the
# system roots and retried every request without a word until their timeout (pilot diagnose, 2026-10-04). Node
# carries its own roots, which is why the network probe answered.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt
COPY --from=tools /out/wal-g /out/rclone /usr/local/bin/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY infra/postgres/pg-ops.mjs /opt/wizard/pg-ops.mjs
RUN wal-g --version && rclone version && node --version
ARG VERSION=dev
LABEL org.opencontainers.image.title="wizard-postgres" org.opencontainers.image.version="${VERSION}"
# uid 999 = postgres of the official image (the chart runs every container of this image as non-root).
USER 999:999
