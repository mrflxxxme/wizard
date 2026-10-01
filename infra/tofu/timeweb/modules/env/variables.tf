variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env is staging or prod."
  }
}

variable "name_prefix" {
  type = string
}

variable "location" {
  description = "Timeweb location of the VMs: Moscow only (founder decision 2026-10-01). S3 lives in ru-1 (the only S3 location)."
  type        = string
  default     = "ru-3"
  validation {
    condition     = var.location == "ru-3"
    error_message = "Only the Moscow location ru-3 is allowed (founder decision 2026-10-01)."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "192.168.10.0/24"
}

variable "pods_cidr" {
  description = "k3s --cluster-cidr (= infra/helm/profiles/k3s.yaml network.podCidr)."
  type        = string
  default     = "10.42.0.0/16"
}

variable "services_cidr" {
  description = "k3s --service-cidr (= infra/helm/profiles/k3s.yaml network.serviceCidr)."
  type        = string
  default     = "10.43.0.0/16"
}

variable "k3s_version" {
  type    = string
  default = "v1.34.1+k3s1"
}

variable "server" {
  description = "k3s server VM (platform pool; also the sandbox pool when sandbox_nodes is empty). max_price (₽/month) → a fixed preset not dearer than that; null → the configurator."
  type        = object({ cpu = number, ram_gb = number, disk_gb = number, max_price = optional(number) })
}

variable "sandbox_nodes" {
  description = "gVisor sandbox agents by pool name (free | paid); {} → single-node environment."
  type        = map(object({ cpu = number, ram_gb = number, disk_gb = number }))
  default     = {}
}

variable "postgres" {
  description = "Managed PostgreSQL (beta). null → pilot: PostgreSQL 16 with WAL-G inside the cluster."
  default     = null
  type = object({
    cpu             = number
    ram_gb          = number
    disk_gb         = number
    max_connections = optional(number, 200)
    backup_copies   = optional(number, 14)
  })
}

variable "backup_start" {
  description = "Date of the first automatic PostgreSQL backup (ISO, the API keeps the date)."
  type        = string
  default     = "2026-10-01T00:00:00"
}

variable "s3_preset_gb" {
  description = "Disk of the S3 preset per bucket (GB) of the beta's five buckets."
  type        = number
  default     = 10
}

variable "buckets" {
  description = "Buckets and their preset size in GB; null → pilot {files = 10, backups = 100}, beta five × s3_preset_gb."
  type        = map(number)
  default     = null
}

variable "image_registry" {
  description = "Image prefix the cluster pulls from: ghcr.io/<owner> (pilot; pull secret wizard-ghcr) or registry.wizard.local (in-cluster registry, pushed by the runner)."
  type        = string
  default     = "registry.wizard.local"
}

variable "docker_mirror" {
  description = "Pull-through mirror of Docker Hub for containerd (Timeweb Cloud: https://dockerhub.timeweb.cloud); empty → none."
  type        = string
  default     = "https://dockerhub.timeweb.cloud"
}

variable "ssh_public_key" {
  description = "Admin SSH public key (the runner uses its private half to fetch the kubeconfig)."
  type        = string
}

variable "admin_cidrs" {
  description = "Networks allowed to SSH into the nodes (the runner VM, the founder)."
  type        = list(string)
  default     = []
}

variable "ddos_guard" {
  type    = bool
  default = false
}

variable "platform_domain" {
  type = string
}

variable "systems_domain" {
  type = string
}

variable "platform_mail_spf" {
  description = "SPF include of the platform mail provider, e.g. include:_spf.example (checklist §6); empty → none."
  type        = string
  default     = ""
}
