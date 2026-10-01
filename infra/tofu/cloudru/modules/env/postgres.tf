# Cloud.ru Managed PostgreSQL 16 (deploy.yaml#cloud.postgres): automatic backups + PITR from the provider
# (retention ≤ 30 days, platform: 14), no pg_dump of thousands of schemas (audit 04 T3). PgBouncer runs in the cluster
# (infra/helm) unless `pooler = true` switches to the managed pooler in transaction mode.
# Roles wizard / wizard_owner / wizard_runtime and the platform schema are created by platform-api migrations and
# docs/ops/deploy.md (bootstrap SQL), not here: role attributes (NOBYPASSRLS, CREATEROLE) are outside the provider.

resource "cloudru_evolution_postgresql_cluster" "pg" {
  for_each                    = var.postgres_clusters
  name                        = "${var.name_prefix}-${each.key}"
  description                 = "Wizard ${var.env}: ${each.key}"
  project_id                  = var.project_id
  version                     = var.postgres_version
  instances                   = each.value.instances
  subnet_ids                  = [cloudru_evolution_compute_subnet.db.id]
  specification_id            = each.value.specification_id
  initial_database            = "wizard"
  initial_database_lc_collate = "C"
  initial_database_lc_ctype   = "C"
  storage = {
    pg_data_gb = each.value.data_gb
    pg_wal_gb  = each.value.wal_gb
  }
  backup = {
    schedule              = each.value.backup_cron
    retention_policy_days = each.value.backup_days
  }
  pooler_config = each.value.pooler ? {
    enabled   = true
    pool_mode = "TRANSACTION"
    parameters = {
      max_prepared_statements = "200"
    }
  } : null
  logging = { enabled = true }
  timeouts {
    create = "90m"
    update = "60m"
    delete = "30m"
  }
  lifecycle {
    # A cluster with data is never replaced by a plan (name, version and description are immutable).
    prevent_destroy = true
    ignore_changes  = [timeouts]
  }
}
