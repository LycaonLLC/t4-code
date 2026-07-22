mock_provider "google" {}

run "default_public_edge_contract" {
  command = apply

  assert {
    condition     = google_compute_global_network_endpoint_group.origin.network_endpoint_type == "INTERNET_FQDN_PORT"
    error_message = "The origin must use a global Internet FQDN NEG."
  }

  assert {
    condition     = google_compute_global_network_endpoint.origin.fqdn == "davailocal.tailb18de3.ts.net" && google_compute_global_network_endpoint.origin.port == 10000
    error_message = "The default origin must target the HTTPS Tailscale Funnel relay."
  }

  assert {
    condition     = google_compute_backend_service.site.protocol == "HTTPS" && contains(google_compute_backend_service.site.custom_request_headers, "Host: davailocal.tailb18de3.ts.net")
    error_message = "The backend must use HTTPS and send the Funnel hostname as the Host header."
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
