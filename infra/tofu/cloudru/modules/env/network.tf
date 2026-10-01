# VPC of the environment: subnet of the Kubernetes nodes (and the self-hosted runner VM) and of Managed PostgreSQL.
resource "cloudru_evolution_vpc_vpc" "main" {
  name        = "${var.name_prefix}-vpc"
  project_id  = var.project_id
  description = "Wizard ${var.env}"
}

resource "cloudru_evolution_compute_subnet" "nodes" {
  project_id      = var.project_id
  zone            = { id = var.zone_id }
  name            = "${var.name_prefix}-nodes"
  vpc_id          = cloudru_evolution_vpc_vpc.main.id
  subnet_address  = cidrhost(var.nodes_cidr, 0)
  prefix_length   = tonumber(split("/", var.nodes_cidr)[1])
  default_gateway = cidrhost(var.nodes_cidr, 1)
  routed_network  = true
}

resource "cloudru_evolution_compute_subnet" "db" {
  project_id      = var.project_id
  zone            = { id = var.zone_id }
  name            = "${var.name_prefix}-db"
  vpc_id          = cloudru_evolution_vpc_vpc.main.id
  subnet_address  = cidrhost(var.db_cidr, 0)
  prefix_length   = tonumber(split("/", var.db_cidr)[1])
  default_gateway = cidrhost(var.db_cidr, 1)
  routed_network  = true
}

# Nodes: everything inside the VPC, HTTP(S) from the load balancer, nothing else from outside.
resource "cloudru_evolution_compute_security_group" "nodes" {
  project_id  = var.project_id
  zone        = { id = var.zone_id }
  name        = "${var.name_prefix}-nodes"
  description = "Wizard ${var.env}: Kubernetes nodes"
}

locals {
  node_rules = {
    vpc_in   = { direction = "TRAFFIC_DIRECTION_INGRESS", protocol = "IP_PROTOCOL_ANY", ports = "", prefix = var.nodes_cidr }
    pods_in  = { direction = "TRAFFIC_DIRECTION_INGRESS", protocol = "IP_PROTOCOL_ANY", ports = "", prefix = var.pods_cidr }
    https_in = { direction = "TRAFFIC_DIRECTION_INGRESS", protocol = "IP_PROTOCOL_TCP", ports = "443", prefix = "0.0.0.0/0" }
    http_in  = { direction = "TRAFFIC_DIRECTION_INGRESS", protocol = "IP_PROTOCOL_TCP", ports = "80", prefix = "0.0.0.0/0" }
    all_out  = { direction = "TRAFFIC_DIRECTION_EGRESS", protocol = "IP_PROTOCOL_ANY", ports = "", prefix = "0.0.0.0/0" }
  }
}

resource "cloudru_evolution_compute_security_group_rule" "nodes" {
  for_each          = local.node_rules
  security_group_id = cloudru_evolution_compute_security_group.nodes.id
  description       = "wizard ${each.key}"
  direction         = each.value.direction
  ether_type        = "ETHER_TYPE_IPV4"
  ip_protocol       = each.value.protocol
  port_range        = each.value.ports == "" ? null : each.value.ports
  remote_ip_prefix  = each.value.prefix
}
