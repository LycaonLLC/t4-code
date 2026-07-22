locals {
  domain       = "t4code.com"
  dns_zone     = "t4code-com"
  resource_tag = "t4-site"
}

data "google_dns_managed_zone" "site" {
  name    = local.dns_zone
  project = var.project_id
}

resource "google_compute_global_network_endpoint_group" "origin" {
  name                  = "${local.resource_tag}-origin-neg"
  project               = var.project_id
  network_endpoint_type = "INTERNET_FQDN_PORT"
  default_port          = var.origin_port
}

resource "google_compute_global_network_endpoint" "origin" {
  project                       = var.project_id
  global_network_endpoint_group = google_compute_global_network_endpoint_group.origin.name
  fqdn                          = var.origin_fqdn
  port                          = var.origin_port
}

resource "google_compute_backend_service" "site" {
  name                  = "${local.resource_tag}-backend"
  project               = var.project_id
  protocol              = "HTTPS"
  port_name             = "https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30

  custom_request_headers = ["Host: ${var.origin_fqdn}"]

  backend {
    group = google_compute_global_network_endpoint_group.origin.self_link
  }
}

resource "google_compute_url_map" "site" {
  name            = "${local.resource_tag}-url-map"
  project         = var.project_id
  default_service = google_compute_backend_service.site.self_link
}

resource "google_compute_managed_ssl_certificate" "site" {
  name    = "${local.resource_tag}-certificate"
  project = var.project_id

  managed {
    domains = [local.domain]
  }
}

resource "google_compute_target_https_proxy" "site" {
  name             = "${local.resource_tag}-https-proxy"
  project          = var.project_id
  url_map          = google_compute_url_map.site.self_link
  ssl_certificates = [google_compute_managed_ssl_certificate.site.self_link]
}

resource "google_compute_global_address" "site" {
  name         = "${local.resource_tag}-address"
  project      = var.project_id
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.resource_tag}-https"
  project               = var.project_id
  target                = google_compute_target_https_proxy.site.self_link
  ip_address            = google_compute_global_address.site.address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "google_compute_url_map" "http_redirect" {
  name    = "${local.resource_tag}-http-redirect"
  project = var.project_id

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http_redirect" {
  name    = "${local.resource_tag}-http-proxy"
  project = var.project_id
  url_map = google_compute_url_map.http_redirect.self_link
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${local.resource_tag}-http"
  project               = var.project_id
  target                = google_compute_target_http_proxy.http_redirect.self_link
  ip_address            = google_compute_global_address.site.address
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "google_dns_record_set" "site" {
  name         = "${local.domain}."
  project      = var.project_id
  managed_zone = data.google_dns_managed_zone.site.name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.site.address]
}
