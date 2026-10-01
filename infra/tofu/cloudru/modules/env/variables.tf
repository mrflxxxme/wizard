# One environment of Wizard in its own Cloud.ru project (deploy.yaml#cloud.environments.isolation).
# IDs of zones, flavors and PostgreSQL specifications are inputs: look them up once in the console (or with the
# provider's *_collection data sources) and put them into envs/<env>/terraform.tfvars (docs/ops/deploy.md).

variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env is staging or prod."
  }
}

variable "project_id" {
  description = "Cloud.ru project of this environment (CLOUDRU_PROJECT_ID)."
  type        = string
}

variable "zone_id" {
  description = "Availability zone (ru-central-1 Moscow) of nodes, subnets and the PostgreSQL clusters."
  type        = string
}

variable "name_prefix" {
  description = "Prefix of resource names, e.g. wizard-staging."
  type        = string
}

# --- network -------------------------------------------------------------------------------------------------------

variable "nodes_cidr" {
  type    = string
  default = "10.0.0.0/22"
}

variable "db_cidr" {
  type    = string
  default = "10.0.8.0/24"
}

variable "pods_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "services_cidr" {
  type    = string
  default = "10.96.0.0/12"
}

# --- kubernetes ----------------------------------------------------------------------------------------------------

variable "k8s_version" {
  type    = string
  default = "v1.34.1"
}

variable "control_plane" {
  description = "Masters: count (1 zonal staging, 3 prod) and flavor id (2 vCPU / 4 GB, checklist §1)."
  type        = object({ count = number, flavor_id = string })
}

variable "node_pools" {
  description = <<-EOT
    Node pools (deploy.yaml#cloud.kubernetes.node_pools): platform (runc) and sandbox pools free / paid
    (gVisor runsc, taint wizard.ru/sandbox=<pool>:NoSchedule, labels wizard.ru/pool=<pool>, wizard.ru/sandbox-node=true).
  EOT
  type = map(object({
    flavor_id = string
    count     = number
    disk_gb   = optional(number, 100)
    sandbox   = optional(bool, false)
  }))
}

variable "kube_api_internet" {
  description = "Publish kube-apiserver to the internet. false: only the VPC (the self-hosted runner lives there)."
  type        = bool
  default     = false
}

variable "paused" {
  description = "Staging on demand: node pools scaled to 0 (tools/deploy/infra.mjs pause/resume). Data, PG and DNS stay."
  type        = bool
  default     = false
}

variable "managed_observability" {
  description = "Also ship control-plane logs/metrics to Cloud.ru Logging/Monitoring (default: only the in-cluster stack)."
  type        = bool
  default     = false
}

variable "kms_kek_id" {
  description = "KMS key (KEK) for Kubernetes secrets encryption; created by hand (no KMS resource in the provider)."
  type        = string
  default     = ""
}

variable "ssh_key_id" {
  description = "SSH key of node pools (\"SSH-ключи\" service); empty → no remote access."
  type        = string
  default     = ""
}

# --- postgres ------------------------------------------------------------------------------------------------------

variable "postgres_clusters" {
  description = <<-EOT
    Managed PostgreSQL 16 clusters (deploy.yaml#cloud.postgres.clusters): platform (HA, PITR 14 days), apps-NN, drafts-NN.
    Staging: one single-node cluster for everything.
  EOT
  type = map(object({
    specification_id = string
    instances        = number
    data_gb          = number
    wal_gb           = optional(number)
    backup_days      = optional(number, 14)
    backup_cron      = optional(string, "0 3 * * *")
    pooler           = optional(bool, false)
  }))
}

variable "postgres_version" {
  type    = string
  default = "16"
}

# --- object storage, dns, registry ---------------------------------------------------------------------------------

variable "platform_domain" {
  description = "<codename>.ru (E-NAME) or the staging platform domain."
  type        = string
}

variable "systems_domain" {
  description = "Neutral systems domain (F8)."
  type        = string
}

variable "ingress_ip" {
  description = "Public IP of the ingress load balancer (known after the first Helm install; second apply sets the A records)."
  type        = string
  default     = ""
}

variable "platform_mail" {
  description = "SPF include and DMARC rua of the platform mail domain (SMTP provider, checklist §6); empty → none."
  type        = object({ spf = string, dmarc_rua = string })
  default     = { spf = "", dmarc_rua = "" }
}
