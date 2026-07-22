variable "project_id" {
  description = "Google Cloud project that owns the public edge resources."
  type        = string
  default     = "media-node-636780"
}

variable "origin_fqdn" {
  description = "Public Tailscale Funnel hostname used by the load balancer's Internet NEG and Host header."
  type        = string
  default     = "davailocal.tailb18de3.ts.net"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.origin_fqdn))
    error_message = "origin_fqdn must be a lowercase fully qualified DNS hostname without a trailing dot."
  }
}

variable "origin_port" {
  description = "HTTPS port exposed by the Tailscale Funnel origin."
  type        = number
  default     = 10000

  validation {
    condition     = var.origin_port >= 1 && var.origin_port <= 65535
    error_message = "origin_port must be between 1 and 65535."
  }
}
