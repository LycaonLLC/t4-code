variable "project_id" {
  description = "Google Cloud project that owns the public edge resources."
  type        = string
  default     = "media-node-636780"
}

variable "region" {
  description = "Google Cloud region for the public edge gateway."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Google Cloud zone for the public edge gateway."
  type        = string
  default     = "us-central1-a"
}

variable "network" {
  description = "VPC network that carries load-balancer traffic to the edge gateway."
  type        = string
  default     = "default"
}

variable "edge_machine_type" {
  description = "Machine type for the single-purpose Tailscale edge gateway."
  type        = string
  default     = "e2-micro"
}

variable "edge_port" {
  description = "HTTP port exposed by the edge gateway to Google Front Ends."
  type        = number
  default     = 8080

  validation {
    condition     = var.edge_port >= 1024 && var.edge_port <= 65535
    error_message = "edge_port must be an unprivileged TCP port between 1024 and 65535."
  }
}

variable "origin_hostname" {
  description = "Tailnet-only Kubernetes ingress hostname proxied by the edge gateway."
  type        = string
  default     = "t4-site.tailb18de3.ts.net"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.origin_hostname))
    error_message = "origin_hostname must be a lowercase fully qualified DNS hostname without a trailing dot."
  }
}

variable "tailscale_tag" {
  description = "Existing tailnet ACL tag assigned to the edge gateway."
  type        = string
  default     = "tag:k8s-shared-ops-ingress-proxy"

  validation {
    condition     = can(regex("^tag:[a-z0-9-]+$", var.tailscale_tag))
    error_message = "tailscale_tag must be a lowercase Tailscale tag."
  }
}
