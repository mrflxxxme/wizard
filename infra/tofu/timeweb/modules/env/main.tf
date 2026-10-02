# One Wizard environment on Timeweb Cloud, RF only: Moscow (ru-3) by default or St Petersburg (ru-1). Two shapes (docs/ops/deploy.md):
#   pilot (founder decision 2026-10-01, ≤ 10 000 ₽/month): ONE VM with single-node k3s carrying everything, PostgreSQL
#     inside the cluster with WAL-G into the backups bucket (settings.postgres = null), buckets files + backups;
#   beta: k3s server + sandbox agents, managed PostgreSQL (settings.postgres = {…}), five buckets.
# Provider-neutral pieces live elsewhere: the k3s bootstrap (infra/k3s/*.tftpl), the chart (infra/helm/wizard), the
# addons. This module only makes VMs, network, (managed) PG, S3, DNS.
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    twc = {
      source  = "timeweb-cloud/timeweb-cloud"
      version = "1.8.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  # Zone of the VM and its floating IP (they must match). St Petersburg: ready presets (e.g. «Cloud-80», id 2455) live
  # in the classic zone spb-1 — spb-3 refused them («location_zone: spb-3 is not valid», live apply 2026-10-02) —
  # while configurator VMs go to spb-3. var.zone overrides (WIZARD_TIMEWEB_ZONE).
  zone = var.zone != "" ? var.zone : lookup(
    { "ru-1" = local.server_preset ? "spb-1" : "spb-3", "ru-2" = "nsk-1", "ru-3" = "msk-1" },
    var.location, var.location,
  )
  server_ip   = cidrhost(var.vpc_cidr, 10)
  agent_ip    = { for i, k in sort(keys(var.sandbox_nodes)) : k => cidrhost(var.vpc_cidr, 20 + i) }
  single_node = length(var.sandbox_nodes) == 0
  # Pilot: no managed PostgreSQL — the chart runs PostgreSQL 16 with WAL-G in the cluster (profile pilot).
  pilot = var.postgres == null
  # Images from an external registry (GHCR) → no in-cluster registry, no push port.
  in_cluster_registry = var.image_registry == "registry.wizard.local"
  # A fixed Timeweb preset (cheaper than the configurator) bounded by a price ceiling: a plan that would need a dearer
  # preset finds none and fails instead of silently raising the bill (auto-growth ceiling, docs/ops/deploy.md).
  server_preset = var.server.max_price != null
}

data "twc_presets" "server" {
  count    = local.server_preset ? 1 : 0
  location = var.location
  cpu      = var.server.cpu
  ram      = var.server.ram_gb * 1024
  disk     = var.server.disk_gb * 1024
  price_filter {
    from = 0
    to   = var.server.max_price
  }
}

resource "random_password" "k3s_token" {
  length  = 48
  special = false
}

resource "random_password" "pg_admin" {
  length  = 32
  special = false
}

data "twc_os" "ubuntu" {
  name    = "ubuntu"
  version = "24.04"
}

data "twc_configurator" "vm" {
  location    = var.location
  preset_type = "premium"
}

resource "twc_vpc" "main" {
  name        = "${var.name_prefix}-vpc"
  description = "Wizard ${var.env}"
  location    = var.location
  subnet_v4   = var.vpc_cidr
}

resource "twc_ssh_key" "admin" {
  name = "${var.name_prefix}-admin"
  body = var.ssh_public_key
}

resource "twc_floating_ip" "ingress" {
  availability_zone = local.zone
  ddos_guard        = var.ddos_guard
  comment           = "Wizard ${var.env}: ingress (platform + systems domains)"
}

# k3s server: control plane + platform workloads (+ the sandbox pool itself when there are no agent nodes).
resource "twc_server" "k3s" {
  name                      = "${var.name_prefix}-k3s"
  hostname                  = "${var.name_prefix}-k3s"
  os_id                     = data.twc_os.ubuntu.id
  availability_zone         = local.zone
  ssh_keys_ids              = [twc_ssh_key.admin.id]
  is_root_password_required = false
  floating_ip_id            = twc_floating_ip.ingress.id
  preset_id                 = local.server_preset ? data.twc_presets.server[0].id : null
  dynamic "configuration" {
    for_each = local.server_preset ? [] : [1]
    content {
      configurator_id = data.twc_configurator.vm.id
      cpu             = var.server.cpu
      ram             = var.server.ram_gb * 1024
      disk            = var.server.disk_gb * 1024
    }
  }
  local_network {
    id   = twc_vpc.main.id
    ip   = local.server_ip
    mode = "dnat_and_snat"
  }
  cloud_init = templatefile("${path.module}/../../../../k3s/server.yaml.tftpl", {
    k3s_version   = var.k3s_version
    token         = random_password.k3s_token.result
    node_ip       = local.server_ip
    public_ip     = twc_floating_ip.ingress.ip
    pods_cidr     = var.pods_cidr
    services_cidr = var.services_cidr
    sandbox_pool  = local.single_node ? "free" : ""
    docker_mirror = var.docker_mirror
  })
  lifecycle {
    # A changed bootstrap template must not silently rebuild the server: re-create explicitly (`-replace`).
    ignore_changes = [cloud_init]
  }
}

# Sandbox agents (gVisor): one VM per pool (free / paid), only in environments that have them.
resource "twc_server" "agent" {
  for_each                  = var.sandbox_nodes
  name                      = "${var.name_prefix}-sandbox-${each.key}"
  hostname                  = "${var.name_prefix}-sandbox-${each.key}"
  os_id                     = data.twc_os.ubuntu.id
  availability_zone         = local.zone
  ssh_keys_ids              = [twc_ssh_key.admin.id]
  is_root_password_required = false
  configuration {
    configurator_id = data.twc_configurator.vm.id
    cpu             = each.value.cpu
    ram             = each.value.ram_gb * 1024
    disk            = each.value.disk_gb * 1024
  }
  local_network {
    id   = twc_vpc.main.id
    ip   = local.agent_ip[each.key]
    mode = "snat"
  }
  cloud_init = templatefile("${path.module}/../../../../k3s/agent.yaml.tftpl", {
    k3s_version   = var.k3s_version
    token         = random_password.k3s_token.result
    server_ip     = local.server_ip
    node_ip       = local.agent_ip[each.key]
    pool          = each.key
    docker_mirror = var.docker_mirror
  })
  lifecycle {
    ignore_changes = [cloud_init]
  }
  depends_on = [twc_server.k3s]
}

# Public side: HTTP(S) only; SSH, the API server and the registry node port only from the VPC and admin_cidrs.
resource "twc_firewall" "nodes" {
  name        = "${var.name_prefix}-nodes"
  description = "Wizard ${var.env}: k3s nodes"
  link {
    id   = twc_server.k3s.id
    type = "server"
  }
  dynamic "link" {
    for_each = twc_server.agent
    content {
      id   = link.value.id
      type = "server"
    }
  }
}

locals {
  ingress_rules = concat(
    [
      { proto = "tcp", port = "80", cidr = "0.0.0.0/0", what = "http (redirect to https)" },
      { proto = "tcp", port = "443", cidr = "0.0.0.0/0", what = "https" },
      { proto = "tcp", port = "1-65535", cidr = var.vpc_cidr, what = "vpc tcp" },
      { proto = "udp", port = "1-65535", cidr = var.vpc_cidr, what = "vpc udp" },
    ],
    # The runner (and the founder): SSH (kubeconfig), the k3s API and the registry node port — never the world.
    flatten([for c in var.admin_cidrs : concat(
      [
        { proto = "tcp", port = "22", cidr = c, what = "ssh admin" },
        { proto = "tcp", port = "6443", cidr = c, what = "k3s api admin" },
      ],
      local.in_cluster_registry ? [{ proto = "tcp", port = "30500", cidr = c, what = "registry push admin" }] : [],
    )]),
  )
}

resource "twc_firewall_rule" "in" {
  for_each    = { for r in local.ingress_rules : "${r.proto}-${r.port}-${r.cidr}" => r }
  firewall_id = twc_firewall.nodes.id
  direction   = "ingress"
  protocol    = each.value.proto
  port        = each.value.port
  cidr        = each.value.cidr
  description = each.value.what
}

resource "twc_firewall_rule" "out" {
  for_each    = toset(["tcp", "udp"])
  firewall_id = twc_firewall.nodes.id
  direction   = "egress"
  protocol    = each.value
  port        = "1-65535"
  cidr        = "0.0.0.0/0"
  description = "egress ${each.value}"
}
