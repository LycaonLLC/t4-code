output "public_ip_address" {
  description = "Global IPv4 address serving t4code.com over HTTP and HTTPS."
  value       = google_compute_global_address.site.address
}

output "public_url" {
  description = "Canonical HTTPS URL for the production site."
  value       = "https://${local.domain}"
}

output "origin_endpoint" {
  description = "HTTPS Funnel origin configured in the Internet NEG."
  value       = "https://${var.origin_fqdn}:${var.origin_port}"
}

output "backend_service_name" {
  description = "Global backend service forwarding requests to the Funnel origin."
  value       = google_compute_backend_service.site.name
}

output "managed_certificate_name" {
  description = "Google-managed certificate resource for t4code.com."
  value       = google_compute_managed_ssl_certificate.site.name
}

output "dns_record_name" {
  description = "Cloud DNS A record managed by this stack."
  value       = google_dns_record_set.site.name
}
