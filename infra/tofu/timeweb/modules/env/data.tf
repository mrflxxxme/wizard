# State of the environment: managed PostgreSQL (single node, daily backups; PITR — see docs/ops/deploy.md), S3 buckets,
# DNS records. Staging is destroyed with everything (synthetic data); prod is protected by tools/deploy/infra.mjs,
# which refuses `destroy` for prod.

data "twc_database_preset" "pg" {
  location = var.location
  type     = "postgres"
  cpu      = var.postgres.cpu
  ram      = var.postgres.ram_gb * 1024
  disk     = var.postgres.disk_gb * 1024
}

resource "twc_database_cluster" "pg" {
  name                         = replace("${var.name_prefix}-pg", "-", "_")
  type                         = "postgres"
  preset_id                    = data.twc_database_preset.pg.id
  is_external_ip               = false
  is_secure_connection_enabled = true
  network {
    id = twc_vpc.main.id
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
  cluster_id = twc_database_cluster.pg.id
  name       = "wizard"
}

resource "twc_database_backup_schedule" "pg" {
  cluster_id = twc_database_cluster.pg.id
  enabled    = true
  interval   = "day"
  copy_count = var.postgres.backup_copies
  # The API keeps only the calendar date of the first backup.
  creation_start_at = var.backup_start
  lifecycle {
    ignore_changes = [creation_start_at]
  }
}

data "twc_s3_preset" "bucket" {
  location      = "ru-1"
  storage_class = "hot"
  disk          = var.s3_preset_gb * 1024
}

locals {
  buckets = toset(["artifacts", "files", "imports", "eval", "backups"])
}

resource "twc_s3_bucket" "b" {
  for_each    = local.buckets
  name        = "${var.name_prefix}-${each.key}"
  type        = "private"
  preset_id   = data.twc_s3_preset.bucket.id
  description = "Wizard ${var.env}: ${each.key}"
}

# DNS: the domains are added to the Timeweb account (and delegated to its NS) by hand once — docs/ops/deploy.md.
data "twc_dns_zone" "systems" {
  name = var.systems_domain
}

data "twc_dns_zone" "platform" {
  name = var.platform_domain
}

locals {
  ingress_ip = twc_floating_ip.ingress.ip
  dns_records = merge(
    {
      systems_wildcard = { zone = data.twc_dns_zone.systems.id, name = "*", type = "A", value = local.ingress_ip }
      systems_root     = { zone = data.twc_dns_zone.systems.id, name = "@", type = "A", value = local.ingress_ip }
      platform_root    = { zone = data.twc_dns_zone.platform.id, name = "@", type = "A", value = local.ingress_ip }
      # The systems domain never sends mail (abuse.yaml#reserved_slugs): SPF -all, DMARC p=reject.
      systems_spf   = { zone = data.twc_dns_zone.systems.id, name = "@", type = "TXT", value = "v=spf1 -all" }
      systems_dmarc = { zone = data.twc_dns_zone.systems.id, name = "_dmarc", type = "TXT", value = "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s" }
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
