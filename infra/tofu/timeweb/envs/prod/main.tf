# Root of prod on Timeweb Cloud: `pnpm infra:apply --env prod` (deploy-prod.yml, repository owner only). Shape from
# terraform.tfvars: pilot (terraform.tfvars.example — one VM, PostgreSQL + WAL-G in the cluster) or beta
# (terraform.tfvars.beta.example — k3s server + sandbox agent, managed PostgreSQL). Credentials: TWC_TOKEN (environment; token
# without Telegram deletion confirmation, provider docs), state in S3 (-backend-config from WIZARD_TF_STATE_*),
# encrypted with TF_VAR_state_passphrase.
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    twc = {
      source  = "timeweb-cloud/timeweb-cloud"
      version = "1.8.2"
    }
  }
  backend "s3" {
    key                         = "wizard/prod.tfstate"
    region                      = "ru-1"
    endpoints                   = { s3 = "https://s3.twcstorage.ru" }
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

variable "state_passphrase" {
  type      = string
  sensitive = true
}
variable "ingress_ip" {
  description = "Unused on Timeweb (the floating IP is part of the module); kept for the infra.mjs contract."
  type        = string
  default     = ""
}
variable "settings" {
  description = "Sizes, domains and the admin key (terraform.tfvars on the runner; see terraform.tfvars.example)."
  type        = any
}

provider "twc" {}

module "env" {
  source            = "../../modules/env"
  env               = "prod"
  name_prefix       = "wizard-prod"
  location          = try(var.settings.location, "ru-3") # Moscow by default; ru-1 (St Petersburg) when Moscow has no free node
  server            = var.settings.server
  sandbox_nodes     = try(var.settings.sandbox_nodes, {})
  postgres          = try(var.settings.postgres, null) # null → pilot: PostgreSQL + WAL-G in the cluster
  buckets           = try(var.settings.buckets, null)
  image_registry    = try(var.settings.image_registry, "registry.wizard.local")
  docker_mirror     = try(var.settings.docker_mirror, "https://dockerhub.timeweb.cloud")
  ssh_public_key    = var.settings.ssh_public_key
  admin_cidrs       = try(var.settings.admin_cidrs, [])
  platform_domain   = var.settings.platform_domain
  systems_domain    = var.settings.systems_domain
  platform_mail_spf = try(var.settings.platform_mail_spf, "")
}

output "env" {
  value = module.env.env
}
output "k3s_server" {
  value = module.env.k3s_server
}
output "postgres" {
  value     = module.env.postgres
  sensitive = true
}
output "s3_keys" {
  value     = module.env.s3_keys
  sensitive = true
}
