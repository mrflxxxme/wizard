# `tofu test` of the Timeweb module offline — no cloud calls, no credentials (CI job deploy-lint).
# Pilot (founder decision 2026-10-01): one Moscow VM from a price-capped preset, no managed PostgreSQL, buckets files +
# backups, images from GHCR, Helm profile pilot. Beta: server + sandbox agent, managed PostgreSQL, five buckets.

# OpenTofu applies mock_provider only when the provider's local name equals its type; here the local name is `twc`
# and the type `timeweb-cloud`, so every data source and resource of the module is overridden instead, and the real
# provider points at a closed local port — nothing can reach the Timeweb API even if an override were missing.
provider "twc" {
  token    = "offline"
  base_url = "http://127.0.0.1:9"
}

# Numeric ids where the provider takes numbers (preset_id, os_id, configurator_id, ssh_keys_ids).
override_data {
  target = data.twc_presets.server
  values = { id = "2447", price = 1800 }
}
override_data {
  target = data.twc_os.ubuntu
  values = { id = "99" }
}
override_data {
  target = data.twc_configurator.vm
  values = { id = "11" }
}
override_data {
  target = data.twc_s3_preset.bucket
  values = { id = "2" }
}
override_data {
  target = data.twc_database_preset.pg
  values = { id = "1733" }
}
override_data {
  target = data.twc_dns_zone.systems
  values = { id = "zone-systems" }
}
override_data {
  target = data.twc_dns_zone.platform
  values = { id = "zone-platform" }
}
override_resource {
  target = twc_ssh_key.admin
  values = { id = "5" }
}
override_resource {
  target = twc_floating_ip.ingress
  values = { id = "ip-1", ip = "203.0.113.10" }
}
override_resource {
  target = twc_vpc.main
  values = { id = "network-1" }
}
override_resource {
  target = twc_server.k3s
  values = { id = "7" }
}
override_resource {
  target = twc_server.agent
  values = { id = "8" }
}
override_resource {
  target = twc_firewall.nodes
  values = { id = "fw-1" }
}
override_resource {
  target = twc_firewall_rule.in
  values = { id = "rule" }
}
override_resource {
  target = twc_firewall_rule.out
  values = { id = "rule" }
}
override_resource {
  target = twc_s3_bucket.b
  values = { id = "b", full_name = "abc-bucket" }
}
override_resource {
  target = twc_dns_rr.r
  values = { id = "rr" }
}
override_resource {
  target = twc_database_cluster.pg
  values = { id = "9", port = 5432, networks = [] }
}
override_resource {
  target = twc_database_instance.wizard
  values = { id = "10" }
}
override_resource {
  target = twc_database_backup_schedule.pg
  values = { id = "11" }
}

mock_provider "random" {}

variables {
  env             = "prod"
  name_prefix     = "wizard-prod"
  server          = { cpu = 4, ram_gb = 8, disk_gb = 80, max_price = 2000 }
  image_registry  = "ghcr.io/owner"
  ssh_public_key  = "ssh-ed25519 AAAA test"
  admin_cidrs     = ["192.0.2.10/32"]
  platform_domain = "platform.example"
  systems_domain  = "systems.example"
}

run "pilot_one_vm_in_moscow" {
  command = apply

  assert {
    condition     = length(twc_server.agent) == 0 && twc_server.k3s[0].availability_zone == "msk-1"
    error_message = "the pilot is one VM in Moscow (msk-1)"
  }
  assert {
    condition     = twc_server.k3s[0].preset_id == 2447 && length(twc_server.k3s[0].configuration) == 0
    error_message = "the pilot VM comes from a fixed preset"
  }
  assert {
    condition     = data.twc_presets.server[0].location == "ru-3" && data.twc_presets.server[0].price_filter[0].to == 2000
    error_message = "the preset search is pinned to Moscow and capped by max_price"
  }
  assert {
    condition     = length(twc_database_cluster.pg) == 0 && length(twc_database_backup_schedule.pg) == 0
    error_message = "the pilot has no managed PostgreSQL"
  }
  assert {
    condition     = toset(keys(twc_s3_bucket.b)) == toset(["files", "backups"])
    error_message = "the pilot has the buckets files and backups"
  }
  assert {
    condition     = output.env.cluster_profile == "pilot" && output.env.postgres_mode == "in-cluster"
    error_message = "infra.mjs must get the Helm profile pilot and the in-cluster database"
  }
  assert {
    condition     = output.env.registry_url == "ghcr.io/owner" && output.env.registry_push == null
    error_message = "images come from GHCR, nothing is pushed by the runner"
  }
  assert {
    condition     = output.env.postgres_cidr == null && output.postgres.main.in_cluster
    error_message = "no managed database address in the pilot"
  }
  assert {
    condition     = length([for r in twc_firewall_rule.in : r if r.port == "30500"]) == 0
    error_message = "no registry push port without the in-cluster registry"
  }
  assert {
    condition     = strcontains(twc_server.k3s[0].cloud_init, "https://dockerhub.timeweb.cloud") && strcontains(twc_server.k3s[0].cloud_init, "wizard.ru/sandbox-node=true")
    error_message = "the single node pulls Docker Hub through the mirror and carries the gVisor sandbox pool"
  }
}

# tools/deploy/pilot.mjs (bootstrap-pilot.yml) passes admin_cidrs = []: nothing but HTTP(S) and the VPC is open between
# jobs; each job adds a temporary SSH rule for its runner's /32 through the API and removes it again.
run "pilot_from_github_hosted_runner_no_standing_admin_access" {
  command = apply
  variables {
    admin_cidrs = []
  }
  assert {
    condition     = length([for r in twc_firewall_rule.in : r if contains(["22", "6443", "30500"], r.port)]) == 0
    error_message = "without admin_cidrs no SSH, API or registry port is open"
  }
  assert {
    condition     = toset([for r in twc_firewall_rule.in : r.port if r.cidr == "0.0.0.0/0"]) == toset(["80", "443"])
    error_message = "the world reaches only HTTP and HTTPS"
  }
  assert {
    condition     = twc_firewall.nodes.name == "wizard-prod-nodes"
    error_message = "pilot.mjs finds the firewall group by the name <name_prefix>-nodes"
  }
}

run "staging_smaller_vm" {
  command = apply
  variables {
    env         = "staging"
    name_prefix = "wizard-staging"
    server      = { cpu = 2, ram_gb = 4, disk_gb = 50, max_price = 1100 }
    buckets     = { files = 10, backups = 10 }
  }
  assert {
    condition     = data.twc_presets.server[0].cpu == 2 && data.twc_presets.server[0].ram == 4096
    error_message = "staging is the same module with a smaller VM"
  }
}

run "beta_managed_postgres" {
  command = apply
  variables {
    server         = { cpu = 4, ram_gb = 8, disk_gb = 100 }
    sandbox_nodes  = { free = { cpu = 4, ram_gb = 8, disk_gb = 50 } }
    postgres       = { cpu = 2, ram_gb = 4, disk_gb = 40, backup_copies = 14 }
    image_registry = "registry.wizard.local"
  }
  assert {
    condition     = length(twc_database_cluster.pg) == 1 && length(twc_server.agent) == 1
    error_message = "the beta keeps managed PostgreSQL and the sandbox agent"
  }
  assert {
    condition     = length(twc_server.k3s[0].configuration) == 1 && length(data.twc_presets.server) == 0
    error_message = "without max_price the configurator is used"
  }
  assert {
    condition     = length(keys(twc_s3_bucket.b)) == 5 && output.env.cluster_profile == "k3s" && output.env.registry_push == "192.168.10.10:30500"
    error_message = "the beta keeps five buckets, the k3s profile and the in-cluster registry"
  }
}

run "rf_only" {
  command = plan
  variables {
    location = "nl-1"
  }
  expect_failures = [var.location]
}

# A VM the founder handed over: nothing of ours is created for compute (no VM, floating IP, VPC), the firewall and DNS
# go to that VM, and it is reinstalled once with the k3s bootstrap carrying the admin key. Plan only: the reinstall is
# a local-exec provisioner and must never run offline.
run "adopted_vm" {
  command = plan
  variables {
    existing_server = { id = 9256729, ip = "129.101.115.207" }
  }
  assert {
    condition     = length(twc_server.k3s) == 0 && length(twc_floating_ip.ingress) == 0 && length(twc_vpc.main) == 0
    error_message = "an adopted VM gets no VM, floating IP or VPC of ours"
  }
  assert {
    condition     = tostring(one(twc_firewall.nodes.link).id) == "9256729" && output.env.ingress_ip == "129.101.115.207"
    error_message = "the firewall and the ingress address are the adopted VM's"
  }
  assert {
    condition     = output.k3s_server.public_ip == "129.101.115.207" && twc_dns_rr.r["platform_root"].value == "129.101.115.207"
    error_message = "DNS and the SSH address point at the adopted VM"
  }
  assert {
    condition     = tostring(terraform_data.adopt[0].triggers_replace[0]) == "9256729"
    error_message = "the reinstall is keyed by the server id (once per VM)"
  }
}
