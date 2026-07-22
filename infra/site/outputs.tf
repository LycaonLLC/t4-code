output "public_ip_address" {
  description = "Global IPv4 address serving t4code.com over HTTP and HTTPS."
  value       = google_compute_global_address.site.address
}

output "public_url" {
  description = "Canonical HTTPS URL for the production site."
  value       = "https://${local.domain}"
}

output "cluster_origin_hostname" {
  description = "Tailnet-only Kubernetes ingress proxied by the edge gateway."
  value       = var.origin_hostname
}

output "edge_instance_name" {
  description = "Compute instance proxying Google Front End traffic into the tailnet."
  value       = google_compute_instance.edge.name
}

output "edge_public_ip_address" {
  description = "Static egress address used by the edge gateway to join the tailnet."
  value       = google_compute_address.edge.address
}

output "tailscale_oauth_secret_name" {
  description = "Secret Manager secret that must contain the edge Tailscale OAuth client secret."
  value       = google_secret_manager_secret.tailscale_oauth.secret_id
}

output "backend_service_name" {
  description = "Global backend service forwarding requests to the edge gateway."
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
