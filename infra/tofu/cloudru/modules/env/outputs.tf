# Read by tools/deploy/infra.mjs (`tofu output -json`) to fill the Helm values.
output "cluster_id" {
  value = cloudru_evolution_mk8s_cluster.main.id
}

output "kubeconfig" {
  description = "kubeconfig of the cluster (base64-decoded); stays on the runner, never in GitHub."
  value       = base64decode(data.cloudru_evolution_mk8s_kube_config_collection.main.kube_config.config)
  sensitive   = true
}

output "registry_name" {
  value = cloudru_evolution_artifact_registry_registry.images.name
}

output "registry_url" {
  description = "Docker host of the registry (<name>.cr.cloud.ru — verify in the console on first use)."
  value       = "${cloudru_evolution_artifact_registry_registry.images.name}.cr.cloud.ru"
}

output "postgres" {
  value = {
    for k, c in cloudru_evolution_postgresql_cluster.pg : k => {
      id                = c.id
      connection_string = c.connection_string
    }
  }
  sensitive = true
}

output "db_subnet_id" {
  value = cloudru_evolution_compute_subnet.db.id
}

output "postgres_cidr" {
  value = var.db_cidr
}

output "network" {
  value = {
    nodes_cidr    = var.nodes_cidr
    pods_cidr     = var.pods_cidr
    services_cidr = var.services_cidr
  }
}

output "buckets" {
  value = { for k, b in cloudru_evolution_obs_bucket.b : k => b.bucket }
}

output "dns_zones" {
  value = {
    systems = {
      id                 = cloudru_evolution_dns_public_zone.systems.id
      confirm_state      = cloudru_evolution_dns_public_zone.systems.confirm_state
      verification_token = cloudru_evolution_dns_public_zone.systems.verification_token
    }
    platform = {
      id                 = cloudru_evolution_dns_public_zone.platform.id
      confirm_state      = cloudru_evolution_dns_public_zone.platform.confirm_state
      verification_token = cloudru_evolution_dns_public_zone.platform.verification_token
    }
  }
}
