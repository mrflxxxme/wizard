# syntax=docker/dockerfile:1.7
# Local rehearsal of the pilot (docs/ops/local-rehearsal.md): the k3s server of infra/k3s/server.yaml.tftpl as a
# privileged container, with runsc for the RuntimeClass gvisor. Same k3s version as the pilot VM
# (infra/tofu/timeweb/modules/env/variables.tf k3s_version) and runsc from the same apt repository as the cloud-init.
# Not a product image: never pushed, never deployed.
ARG K3S_IMAGE=rancher/k3s:v1.34.1-k3s1

FROM debian:bookworm-slim AS gvisor
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
      > /etc/apt/sources.list.d/gvisor.list \
 && apt-get update && apt-get install -y --no-install-recommends runsc \
 && runsc --version

FROM ${K3S_IMAGE}
# runsc and its shim are static binaries; k3s finds the shim on PATH (io.containerd.runsc.v1). Since 2026 releases runsc
# also needs its sidecars next to itself (<dir of runsc>/gvisor-bin/gvisor_sentry, …): the whole package layout moves.
COPY --from=gvisor /usr/bin/runsc /usr/bin/containerd-shim-runsc-v1 /bin/
COPY --from=gvisor /usr/bin/gvisor-bin /bin/gvisor-bin
# containerd 2 template of k3s ≥ v1.32 — the same handler block as the cloud-init of the pilot VM. platform=systrap as
# in the CI job sandbox (works inside a privileged container of Docker Desktop, no KVM needed).
COPY infra/local/containerd-config-v3.toml.tmpl /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl
COPY infra/local/runsc.toml /etc/containerd/runsc.toml
