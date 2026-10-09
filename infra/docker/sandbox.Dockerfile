# workerd of the sandbox pods (security/isolation.yaml#M2; apps/runtime/src/sandbox/pod.ts, M2-18): the binary only,
# non-root (uid 65532 as in sandboxPod()), no shell needed at run time; the config comes from the pod's ConfigMap.
# Pinned by version and sha256 of the npm tarball — the same version as WORKERD_VERSION of .github/workflows/sandbox.yml
# (tools/deploy/test/helm.test.ts keeps them equal). workerd: Apache-2.0 (THIRD_PARTY_NOTICES.md).
ARG TOOLS_IMAGE=debian:bookworm-slim

FROM ${TOOLS_IMAGE} AS fetch
ARG WORKERD_VERSION=1.20260930.1
ADD --checksum=sha256:970d8e5391aeb6408b0a106d805800abf27a4d4343478b5f59582953adc434be \
    https://registry.npmjs.org/@cloudflare/workerd-linux-64/-/workerd-linux-64-${WORKERD_VERSION}.tgz /tmp/workerd.tgz
RUN mkdir -p /out \
 && tar -xzf /tmp/workerd.tgz -C /tmp \
 && install -m 0755 /tmp/package/bin/workerd /out/workerd

# glibc ≥ 2.35 (bookworm: 2.36); workerd links only libc and libm.
FROM ${TOOLS_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/mrflxxxme/wizard" \
      org.opencontainers.image.description="Wizard sandbox (workerd)"
COPY --from=fetch /out/workerd /usr/local/bin/workerd
RUN /usr/local/bin/workerd --version
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/workerd"]
CMD ["--version"]
