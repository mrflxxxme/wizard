# Provider contract (infra/tofu/<provider>/provider.json → outputs), read by tools/deploy/infra.mjs.
output "env" {
  value = {
    # Pods pull through the k3s mirror; the runner pushes to the node port over the VPC (infra/helm/addons/registry).
    registry_url  = var.image_registry
    registry_push = local.in_cluster_registry ? "${local.server_ip}:30500" : null
    domains       = { platform = var.platform_domain, systems = var.systems_domain }
    network       = { pods_cidr = var.pods_cidr, services_cidr = var.services_cidr, nodes_cidr = var.vpc_cidr }
    postgres_cidr = local.pilot ? null : var.vpc_cidr
    # Pilot: PostgreSQL in the cluster and the Helm profile `pilot` (tools/deploy/infra.mjs reads both).
    postgres_mode   = local.pilot ? "in-cluster" : "managed"
    cluster_profile = local.pilot ? "pilot" : "k3s"
    s3_endpoint     = "https://s3.twcstorage.ru"
    buckets         = { for k, b in twc_s3_bucket.b : k => b.full_name }
    ingress_ip      = twc_floating_ip.ingress.ip
  }
}

output "k3s_server" {
  value = { private_ip = local.server_ip, public_ip = twc_floating_ip.ingress.ip }
}

locals {
  pg_host = local.pilot ? "" : try([for n in twc_database_cluster.pg[0].networks : n.ips[0].ip if n.type == "local"][0], "")
}

output "postgres" {
  value = local.pilot ? { main = { in_cluster = true } } : {
    main = {
      id                = twc_database_cluster.pg[0].id
      host              = local.pg_host
      connection_string = "postgres://wizard:${random_password.pg_admin.result}@${local.pg_host}:${twc_database_cluster.pg[0].port}/wizard?sslmode=require"
    }
  }
  sensitive = true
}

output "s3_keys" {
  description = "Per-bucket S3 keys (go into the platform Secret through OpenBao, never into GitHub)."
  value       = { for k, b in twc_s3_bucket.b : k => { access_key = b.access_key, secret_key = b.secret_key } }
  sensitive   = true
}
