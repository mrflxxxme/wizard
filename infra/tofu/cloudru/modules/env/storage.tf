# Cloud.ru Object Storage (deploy.yaml#cloud.object_storage). SSE-KMS default encryption is not exposed by the
# provider: set it per bucket with the S3 API after the first apply (docs/ops/deploy.md, «Шифрование бакетов»).
locals {
  buckets = {
    artifacts = { versioning = true, expire_days = 0, noncurrent_days = 90 }
    files     = { versioning = false, expire_days = 0, noncurrent_days = 0 }
    imports   = { versioning = false, expire_days = 7, noncurrent_days = 0 }
    eval      = { versioning = false, expire_days = 180, noncurrent_days = 0 }
    backups   = { versioning = true, expire_days = 1095, noncurrent_days = 30 }
  }
}

resource "cloudru_evolution_obs_bucket" "b" {
  for_each      = local.buckets
  bucket        = "${var.name_prefix}-${each.key}"
  versioning    = each.value.versioning
  storage_class = "STANDARD"
  # Never public: objects are reached through presigned links (files, TTL ≤ 15 min) or service keys.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::${var.name_prefix}-${each.key}", "arn:aws:s3:::${var.name_prefix}-${each.key}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  lifecycle_rules = concat(
    each.value.expire_days > 0 ? [{
      name       = "expire"
      enabled    = true
      expiration = { days = each.value.expire_days }
      filter     = { prefix = "" }
    }] : [],
    each.value.noncurrent_days > 0 ? [{
      name                          = "noncurrent"
      enabled                       = true
      noncurrent_version_expiration = { days = each.value.noncurrent_days }
      filter                        = { prefix = "" }
    }] : [],
    [{
      name                              = "abort-multipart"
      enabled                           = true
      abort_incomplete_multipart_upload = { days = 2 }
      filter                            = { prefix = "" }
    }],
  )
  tags = [
    { key = "env", value = var.env },
    { key = "app", value = "wizard" },
  ]
  lifecycle {
    prevent_destroy = true
  }
}
