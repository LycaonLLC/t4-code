mock_provider "google" {}

run "default_public_edge_contract" {
  command = apply

  assert {
    condition     = google_compute_instance.edge.zone == "us-central1-a" && google_compute_instance.edge.machine_type == "e2-micro"
    error_message = "The edge gateway must use the small, explicitly zoned default instance."
  }

  assert {
    condition     = google_compute_backend_service.site.protocol == "HTTP" && google_compute_backend_service.site.port_name == "http"
    error_message = "Google Front Ends must proxy HTTP to the private edge gateway port."
  }

  assert {
    condition     = !google_compute_network.edge.auto_create_subnetworks && google_compute_subnetwork.edge.ip_cidr_range == "10.64.0.0/28"
    error_message = "The public gateway must run in an isolated custom subnet."
  }

  assert {
    condition     = contains(google_compute_firewall.edge_from_google.source_ranges, "130.211.0.0/22") && contains(google_compute_firewall.edge_from_google.source_ranges, "35.191.0.0/16")
    error_message = "Only documented Google Front End and health-check ranges may reach the gateway."
  }

  assert {
    condition     = google_secret_manager_secret.tailscale_oauth.secret_id == "t4-site-edge-tailscale-oauth-client-secret" && google_secret_manager_secret_iam_member.edge_oauth.member == "serviceAccount:${google_service_account.edge.email}"
    error_message = "The gateway alone must be able to read its Tailscale credential."
  }

  assert {
    condition     = strcontains(google_compute_instance.edge.metadata_startup_script, "t4-site.tailb18de3.ts.net") && strcontains(google_compute_instance.edge.metadata_startup_script, "tag:k8s-shared-ops-ingress-proxy")
    error_message = "The gateway bootstrap must proxy the private Kubernetes ingress with the shared-ops identity."
  }

  assert {
    condition     = length(google_compute_managed_ssl_certificate.site.managed[0].domains) == 1 && contains(google_compute_managed_ssl_certificate.site.managed[0].domains, "t4code.com")
    error_message = "The Google-managed certificate must cover t4code.com."
  }

  assert {
    condition     = google_compute_url_map.http_redirect.default_url_redirect[0].https_redirect && !google_compute_url_map.http_redirect.default_url_redirect[0].strip_query
    error_message = "The port 80 URL map must redirect to HTTPS without dropping the query string."
  }

  assert {
    condition     = google_compute_global_forwarding_rule.http.ip_address == google_compute_global_forwarding_rule.https.ip_address
    error_message = "HTTP and HTTPS must share the same global address."
  }

  assert {
    condition     = google_dns_record_set.site.name == "t4code.com." && google_dns_record_set.site.managed_zone == "t4code-com" && google_dns_record_set.site.type == "A"
    error_message = "Cloud DNS must publish an A record for t4code.com in the existing t4code-com zone."
  }
}
