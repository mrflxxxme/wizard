# PITR restore drill (deploy.yaml#cloud.postgres.restore_drill, M2-06 acceptance): restore the staging cluster to
# T − 1 h into a NEW cluster, check the control rows (tools/deploy/pitr-drill.mjs verify), destroy it. Monthly.
# Run by `node tools/deploy/pitr-drill.mjs restore --env staging --at <RFC 1123 time>` (docs/ops/deploy.md).
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    cloudru = {
      source  = "cloudru/cloud"
      version = "2.1.3"
    }
  }
  backend "s3" {
    region                      = "ru-central-1"
    endpoints                   = { s3 = "https://s3.cloud.ru" }
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "project_id" {
  type = string
}
variable "iac_key_id" {
  type      = string
  sensitive = true
}
variable "iac_key_secret" {
  type      = string
  sensitive = true
}
variable "state_passphrase" {
  type      = string
  sensitive = true
}
variable "source_cluster_id" {
  description = "Cluster to restore (tofu output postgres of the environment)."
  type        = string
}
variable "pitr" {
  description = "Point in time, RFC 1123 in UTC, e.g. \"Thu, 01 Oct 2026 11:00:00 UTC\" (T − 1 h)."
  type        = string
  validation {
    condition     = can(regex("^[A-Z][a-z]{2}, \\d{2} [A-Z][a-z]{2} \\d{4} \\d{2}:\\d{2}:\\d{2} UTC$", var.pitr))
    error_message = "pitr must look like \"Thu, 01 Oct 2026 11:00:00 UTC\"."
  }
}
variable "specification_id" {
  type = string
}
variable "subnet_id" {
  type = string
}
variable "data_gb" {
  type    = number
  default = 50
}
variable "name" {
  type    = string
  default = "wizard-pitr-drill"
}

provider "cloudru" {
  project_id  = var.project_id
  auth_key_id = var.iac_key_id
  auth_secret = var.iac_key_secret
}

resource "cloudru_evolution_postgresql_cluster" "restored" {
  name             = var.name
  description      = "PITR drill of ${var.source_cluster_id} at ${var.pitr}"
  project_id       = var.project_id
  version          = "16"
  instances        = 1
  subnet_ids       = [var.subnet_id]
  specification_id = var.specification_id
  initial_database = "wizard"
  storage          = { pg_data_gb = var.data_gb }
  recovery_spec = {
    cluster_id = var.source_cluster_id
    pitr       = var.pitr
  }
  timeouts {
    create = "120m"
    delete = "30m"
  }
}

output "connection_string" {
  value     = cloudru_evolution_postgresql_cluster.restored.connection_string
  sensitive = true
}
output "cluster_id" {
  value = cloudru_evolution_postgresql_cluster.restored.id
}
