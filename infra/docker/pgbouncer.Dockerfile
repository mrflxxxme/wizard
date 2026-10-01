# syntax=docker/dockerfile:1.7
# PgBouncer ≥ 1.21 (ISC) in transaction mode in front of Cloud.ru Managed PostgreSQL (deploy.yaml#cloud.postgres.pooling,
# L3-21). Config and userlist come from the chart (ConfigMap + Secret at /etc/pgbouncer); nothing is baked in.
# Used when the managed pooler cannot set max_prepared_statements > 0 (week-0 question, docs/ops/deploy.md).
ARG ALPINE_IMAGE=alpine:3.22
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache pgbouncer \
 && pgbouncer --version \
 && addgroup -S -g 1001 bouncer && adduser -S -D -H -u 1001 -G bouncer bouncer
USER 1001:1001
EXPOSE 6432
ENTRYPOINT ["pgbouncer"]
CMD ["/etc/pgbouncer/pgbouncer.ini"]
