# Evolution DNS public zones of the platform domain and the neutral systems domain (deploy.yaml#cloud.domains).
# Zone verification (TXT at the registrar) and NS delegation are manual (docs/ops/deploy.md); afterwards the ACME
# webhook (infra/acme-cloudru) adds and removes _acme-challenge TXT records through the API — they live only during a
# challenge, so a concurrent apply at most removes one in-flight challenge (cert-manager retries).
locals {
  a = var.ingress_ip == "" ? [] : [var.ingress_ip]
  # Only Let's Encrypt may issue for both domains; the systems domain never sends mail (abuse.yaml#reserved_slugs).
  caa = ["0 issue \"letsencrypt.org\"", "0 issuewild \"letsencrypt.org\"", "0 iodef \"mailto:security@${var.platform_domain}\""]
}

resource "cloudru_evolution_dns_public_zone" "systems" {
  name                           = "${var.name_prefix}-systems"
  domain                         = var.systems_domain
  project_id                     = var.project_id
  description                    = "Wizard ${var.env}: systems (<slug>, <slug>--draft)"
  auto_update_verification_token = true
  records = concat(
    [
      { name = "", type = "caa", ttl = 3600, values = local.caa },
      # No mail from the systems domain: SPF -all, DMARC p=reject (abuse.yaml#reserved_slugs).
      { name = "", type = "txt", ttl = 3600, values = ["v=spf1 -all"] },
      { name = "_dmarc", type = "txt", ttl = 3600, values = ["v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"] },
    ],
    length(local.a) == 0 ? [] : [
      { name = "*", type = "a", ttl = 300, values = local.a, wildcard = true },
    ],
  )
}

resource "cloudru_evolution_dns_public_zone" "platform" {
  name                           = "${var.name_prefix}-platform"
  domain                         = var.platform_domain
  project_id                     = var.project_id
  description                    = "Wizard ${var.env}: platform UI and API"
  auto_update_verification_token = true
  records = concat(
    [{ name = "", type = "caa", ttl = 3600, values = local.caa }],
    length(local.a) == 0 ? [] : [{ name = "", type = "a", ttl = 300, values = local.a }],
    var.platform_mail.spf == "" ? [] : [
      { name = "", type = "txt", ttl = 3600, values = ["v=spf1 ${var.platform_mail.spf} -all"] },
    ],
    var.platform_mail.dmarc_rua == "" ? [] : [
      { name = "_dmarc", type = "txt", ttl = 3600, values = ["v=DMARC1; p=quarantine; rua=mailto:${var.platform_mail.dmarc_rua}"] },
    ],
  )
  lifecycle {
    # DKIM records of the SMTP provider are added by hand (selector is provider-specific).
    ignore_changes = [records]
  }
}
