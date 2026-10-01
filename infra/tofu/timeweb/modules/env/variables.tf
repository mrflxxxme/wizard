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
  description = "Timeweb location: ru-1 (St. Petersburg, the only one with S3 in production) or ru-3 (Moscow)."
  type        = string
  default     = "ru-1"
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
  description = "k3s server VM (platform pool; also the sandbox pool when sandbox_nodes is empty)."
  type        = object({ cpu = number, ram_gb = number, disk_gb = number })
}

variable "sandbox_nodes" {
  description = "gVisor sandbox agents by pool name (free | paid); {} → single-node environment."
  type        = map(object({ cpu = number, ram_gb = number, disk_gb = number }))
  default     = {}
}

variable "postgres" {
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
  description = "Disk of the S3 preset per bucket (GB)."
  type        = number
  default     = 10
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
