locals {
  domain       = "t4code.com"
  dns_zone     = "t4code-com"
  resource_tag = "t4-site"
}

data "google_dns_managed_zone" "site" {
  name    = local.dns_zone
  project = var.project_id
}

resource "google_service_account" "edge" {
  account_id   = "t4-site-edge"
  display_name = "t4code.com edge gateway"
  project      = var.project_id
}

resource "google_secret_manager_secret" "tailscale_oauth" {
  project   = var.project_id
  secret_id = "t4-site-edge-tailscale-oauth-client-secret"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "edge_oauth" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.tailscale_oauth.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.edge.email}"
}

resource "google_compute_network" "edge" {
  name                    = "${local.resource_tag}-edge-network"
  project                 = var.project_id
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "edge" {
  name                     = "${local.resource_tag}-edge-subnet"
  project                  = var.project_id
  region                   = var.region
  network                  = google_compute_network.edge.id
  ip_cidr_range            = "10.64.0.0/28"
  private_ip_google_access = true
}

resource "google_compute_address" "edge" {
  name         = "${local.resource_tag}-edge-address"
  project      = var.project_id
  region       = var.region
  address_type = "EXTERNAL"
}

resource "google_compute_firewall" "edge_from_google" {
  name          = "${local.resource_tag}-edge-from-google"
  project       = var.project_id
  network       = google_compute_network.edge.id
  direction     = "INGRESS"
  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  target_tags   = [local.resource_tag]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.edge_port)]
  }
}

resource "google_compute_instance" "edge" {
  name         = "${local.resource_tag}-edge"
  project      = var.project_id
  zone         = var.zone
  machine_type = var.edge_machine_type
  tags         = [local.resource_tag]

  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "projects/debian-cloud/global/images/family/debian-12"
      size  = 10
      type  = "pd-standard"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.edge.id

    access_config {
      nat_ip = google_compute_address.edge.address
    }
  }

  service_account {
    email  = google_service_account.edge.email
    scopes = ["cloud-platform"]
  }

  metadata_startup_script = templatefile("${path.module}/edge-startup.sh.tftpl", {
    edge_port       = var.edge_port
    origin_hostname = var.origin_hostname
    project_id      = var.project_id
    secret_id       = google_secret_manager_secret.tailscale_oauth.secret_id
    tailscale_tag   = var.tailscale_tag
  })

  depends_on = [google_secret_manager_secret_iam_member.edge_oauth]
}

resource "google_compute_instance_group" "edge" {
  name      = "${local.resource_tag}-edge-group-v2"
  project   = var.project_id
  zone      = var.zone
  network   = google_compute_network.edge.id
  instances = [google_compute_instance.edge.self_link]

  named_port {
    name = "http"
    port = var.edge_port
  }
  lifecycle {
    create_before_destroy = true
  }

}

resource "google_compute_health_check" "site" {
  name                = "${local.resource_tag}-health"
  project             = var.project_id
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = var.edge_port
    request_path = "/healthz"
  }
}

resource "google_compute_backend_service" "site" {
  name                  = "${local.resource_tag}-backend"
  project               = var.project_id
  protocol              = "HTTP"
  port_name             = "http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30
  health_checks         = [google_compute_health_check.site.self_link]

  backend {
    group = google_compute_instance_group.edge.self_link
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
