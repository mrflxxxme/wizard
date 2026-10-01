# Root of the prod environment: `pnpm infra:apply --env prod` (tools/deploy/infra.mjs) runs init/plan/apply here.
# Credentials (checklist §1, §8): TF_VAR_project_id ← CLOUDRU_PROJECT_ID, TF_VAR_iac_key_id ← CLOUDRU_IAC_KEY_ID,
# TF_VAR_iac_key_secret ← CLOUDRU_IAC_KEY_SECRET; state in Cloud.ru Object Storage (-backend-config from
# WIZARD_TF_STATE_*), encrypted client-side with TF_VAR_state_passphrase (OpenTofu state encryption).
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    cloudru = {
      source  = "cloudru/cloud"
      version = "2.1.3"
    }
  }
  backend "s3" {
    key                         = "wizard/prod.tfstate"
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
variable "object_storage_tenant_id" {
  type    = string
  default = ""
}
variable "ingress_ip" {
  description = "Public IP of the ingress LoadBalancer (tools/deploy/infra.mjs passes it on the second apply)."
  type        = string
  default     = ""
}
variable "paused" {
  description = "Node pools scaled to 0 (infra.mjs pause); false brings them back (resume)."
  type        = bool
  default     = false
}
variable "settings" {
  description = "Everything else of the module (terraform.tfvars, see terraform.tfvars.example)."
  type        = any
}

provider "cloudru" {
  project_id               = var.project_id
  auth_key_id              = var.iac_key_id
  auth_secret              = var.iac_key_secret
  region                   = "ru-central-1"
  object_storage_tenant_id = var.object_storage_tenant_id
}

module "env" {
  source            = "../../modules/env"
  env               = "prod"
  project_id        = var.project_id
  name_prefix       = "wizard-prod"
  zone_id           = var.settings.zone_id
  control_plane     = var.settings.control_plane
  node_pools        = var.settings.node_pools
  postgres_clusters = var.settings.postgres_clusters
  platform_domain   = var.settings.platform_domain
  systems_domain    = var.settings.systems_domain
  ingress_ip        = var.ingress_ip != "" ? var.ingress_ip : try(var.settings.ingress_ip, "")
  kms_kek_id        = try(var.settings.kms_kek_id, "")
  kube_api_internet = try(var.settings.kube_api_internet, false)
  paused            = var.paused
}

output "env" {
  value = {
    cluster_id    = module.env.cluster_id
    registry_url  = module.env.registry_url
    postgres_cidr = module.env.postgres_cidr
    network       = module.env.network
    buckets       = module.env.buckets
    dns_zones     = module.env.dns_zones
    domains       = { platform = var.settings.platform_domain, systems = var.settings.systems_domain }
    db_subnet_id  = module.env.db_subnet_id
  }
}
output "kubeconfig" {
  value     = module.env.kubeconfig
  sensitive = true
}
output "postgres" {
  value     = module.env.postgres
  sensitive = true
}
