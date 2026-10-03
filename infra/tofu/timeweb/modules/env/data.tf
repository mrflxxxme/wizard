# State of the environment: managed PostgreSQL (beta only: single node, daily backups), S3 buckets (pilot: files +
# backups — WAL-G and the .data copy), DNS records. Staging is destroyed with everything (synthetic data); prod is
# protected by tools/deploy/infra.mjs, which refuses `destroy` for prod.

data "twc_database_preset" "pg" {
  count    = local.pilot ? 0 : 1
  location = var.location
  type     = "postgres"
  cpu      = var.postgres.cpu
  ram      = var.postgres.ram_gb * 1024
  disk     = var.postgres.disk_gb * 1024
}

resource "twc_database_cluster" "pg" {
  count                        = local.pilot ? 0 : 1
  name                         = replace("${var.name_prefix}-pg", "-", "_")
  type                         = "postgres"
  preset_id                    = data.twc_database_preset.pg[0].id
  is_external_ip               = false
  is_secure_connection_enabled = true
  network {
    id = twc_vpc.main[0].id
  }
  config_parameters = {
    max_connections = tostring(var.postgres.max_connections)
  }
  admin {
    login    = "wizard"
    password = random_password.pg_admin.result
  }
}

resource "twc_database_instance" "wizard" {
  count      = local.pilot ? 0 : 1
  cluster_id = twc_database_cluster.pg[0].id
  name       = "wizard"
}

resource "twc_database_backup_schedule" "pg" {
  count      = local.pilot ? 0 : 1
  cluster_id = twc_database_cluster.pg[0].id
  enabled    = true
  interval   = "day"
  copy_count = var.postgres.backup_copies
  # The API keeps only the calendar date of the first backup.
  creation_start_at = var.backup_start
  lifecycle {
    ignore_changes = [creation_start_at]
  }
}

# Object storage of Timeweb Cloud exists only in St. Petersburg (ru-1) — the one part of the environment outside
# Moscow; still in RF (compliance.yaml#platform.localization). Preset size per bucket: var.bucket_gb.
data "twc_s3_preset" "bucket" {
  for_each      = toset([for k, gb in local.buckets : tostring(gb)])
  location      = "ru-1"
  storage_class = "hot"
  disk          = tonumber(each.key) * 1024
}

locals {
  buckets = var.buckets != null ? var.buckets : (
    local.pilot
    ? { files = 10, backups = 100 }
    : { artifacts = var.s3_preset_gb, files = var.s3_preset_gb, imports = var.s3_preset_gb, eval = var.s3_preset_gb, backups = var.s3_preset_gb }
  )
}

resource "twc_s3_bucket" "b" {
  for_each    = local.buckets
  name        = "${var.name_prefix}-${each.key}"
  type        = "private"
  preset_id   = data.twc_s3_preset.bucket[tostring(each.value)].id
  description = "Wizard ${var.env}: ${each.key}"
  # A full bucket moves to the next preset instead of refusing writes (WAL archive, uploads).
  is_allow_auto_upgrade = true
}

# DNS: the domains are added to the Timeweb account (and delegated to its NS) by hand once — docs/ops/deploy.md.
data "twc_dns_zone" "systems" {
  name = var.systems_domain
}

data "twc_dns_zone" "platform" {
  name = var.platform_domain
}

locals {
  ingress_ip = local.adopt ? var.existing_server.ip : twc_floating_ip.ingress[0].ip
  dns_records = merge(
    {
      systems_wildcard = { zone = data.twc_dns_zone.systems.id, name = "*", type = "A", value = local.ingress_ip }
      systems_root     = { zone = data.twc_dns_zone.systems.id, name = "@", type = "A", value = local.ingress_ip }
      platform_root    = { zone = data.twc_dns_zone.platform.id, name = "@", type = "A", value = local.ingress_ip }
      # The systems domain never sends mail (abuse.yaml#reserved_slugs): SPF -all, DMARC p=reject.
      systems_spf = { zone = data.twc_dns_zone.systems.id, name = "@", type = "TXT", value = "v=spf1 -all" }
      # DMARC p=reject: the provider makes "_dmarc" a subdomain object, which Timeweb refuses ("Bad subdomain name"),
      # so tools/deploy/pilot.mjs adds this TXT through the DNS records API (ensureDmarc).
    },
    var.platform_mail_spf == "" ? {} : {
      platform_spf = { zone = data.twc_dns_zone.platform.id, name = "@", type = "TXT", value = "v=spf1 ${var.platform_mail_spf} -all" }
    },
  )
}

resource "twc_dns_rr" "r" {
  for_each = local.dns_records
  zone_id  = each.value.zone
  name     = each.value.name
  type     = each.value.type
  value    = each.value.value
}
