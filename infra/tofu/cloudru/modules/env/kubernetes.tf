# Cloud.ru Managed Kubernetes (deploy.yaml#cloud.kubernetes): platform pool (runc) and sandbox pools free / paid for
# workerd under gVisor (W0-CLOUDRU-GVISOR: if the managed pools cannot run runsc, the sandbox pools move to a kubeadm
# cluster on VMs — docs/ops/deploy.md). Cilium as CNI: NetworkPolicy default-deny is enforced by it.

resource "cloudru_evolution_iam_service_account" "cluster" {
  target      = { project_id = var.project_id }
  name        = "${var.name_prefix}-k8s"
  description = "Wizard ${var.env}: Managed Kubernetes (registry pull, logs, metrics)"
  enabled     = true
}

resource "cloudru_evolution_mk8s_cluster" "main" {
  name       = "${var.name_prefix}-k8s"
  project_id = var.project_id
  control_plane = {
    zones   = [var.zone_id]
    count   = var.control_plane.count
    version = var.k8s_version
    machine_configuration = {
      flavor = { flavor_id = var.control_plane.flavor_id }
    }
  }
  network_configuration = {
    services_subnet_cidr  = var.services_cidr
    pods_subnet_cidr      = var.pods_cidr
    kube_api_internet     = var.kube_api_internet
    private_vip_subnet_id = cloudru_evolution_compute_subnet.nodes.id
    network_plugin = {
      cilium = { enabled = true, app_version = "v1.16.7" }
    }
  }
  identity_configuration = {
    cluster_sa_id = cloudru_evolution_iam_service_account.cluster.id
  }
  key_management_service = var.kms_kek_id == "" ? null : { enabled = true, kek_id = var.kms_kek_id }
  # Observability is the provider-neutral in-cluster stack (infra/helm/addons); Cloud.ru services are optional.
  logging_service    = { enabled = var.managed_observability }
  monitoring_service = { enabled = var.managed_observability }
  audit_service      = { enabled = true }
  release_channel    = "RELEASE_CHANNEL_STABLE"
  bootstrap_managed_addons = {
    horizontal_pod_autoscaling = { enabled = true }
    persistent_disk_csi_driver = { enabled = true }
    kube_proxy                 = { enabled = true }
    coredns                    = { enabled = true }
  }
  timeouts {
    create = "60m"
    update = "30m"
    delete = "30m"
  }
  lifecycle {
    ignore_changes = [timeouts]
  }
}

resource "cloudru_evolution_mk8s_node_pool" "pool" {
  for_each   = var.node_pools
  cluster_id = cloudru_evolution_mk8s_cluster.main.id
  name       = "${var.name_prefix}-${each.key}"
  version    = var.k8s_version
  machine_configuration = {
    disk   = { type_name = "SSD", size = each.value.disk_gb }
    flavor = { flavor_id = each.value.flavor_id }
  }
  network_configuration = {
    nodes_subnet_id   = cloudru_evolution_compute_subnet.nodes.id
    security_group_id = cloudru_evolution_compute_security_group.nodes.id
  }
  update_configuration = {
    strategy              = "NODE_POOL_UPDATE_STRATEGY_ROLLING_UPDATE"
    rolling_update_policy = { max_surge = 25, max_unavailable = 0 }
  }
  scale_policy = {
    fixed_scale = { count = var.paused ? 0 : each.value.count }
  }
  # Sandbox pools: only pods that tolerate the taint (apps/runtime sandboxPod) land here.
  taints = each.value.sandbox ? {
    taints = [{
      key    = "wizard.ru/sandbox"
      value  = each.key
      effect = "EFFECT_NO_SCHEDULE"
    }]
  } : null
  labels = {
    labels = merge(
      { "wizard.ru/pool" = each.key },
      each.value.sandbox ? { "wizard.ru/sandbox-node" = "true" } : {},
    )
  }
  remote_access = var.ssh_key_id == "" ? null : { ssh_key_id = var.ssh_key_id, username = "wizard" }
  auto_repair   = { enabled = true }
  timeouts {
    create = "60m"
    update = "30m"
    delete = "30m"
  }
  lifecycle {
    ignore_changes = [timeouts]
  }
}

data "cloudru_evolution_mk8s_kube_config_collection" "main" {
  cluster_id = cloudru_evolution_mk8s_cluster.main.id
}
