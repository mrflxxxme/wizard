# Cloud.ru Artifact Registry for the images of infra/docker/images.json (deploy.yaml#cloud.ci_cd.cd).
resource "cloudru_evolution_artifact_registry_registry" "images" {
  name                        = var.name_prefix
  project_id                  = var.project_id
  registry_type               = "DOCKER"
  registry_mode               = "REGISTRY_MODE_LOCAL"
  is_public                   = false
  quarantine_mode             = "DISABLED"
  retention_policy_is_enabled = true
  retention_policy = {
    only_untagged = true
    action        = "DELETE"
    constraint    = "OLDER_THAN"
    value         = 30
    unit          = "d"
    on            = "LAST_PULLED_AT"
  }
}
