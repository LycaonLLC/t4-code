terraform {
  required_version = ">= 1.7.0, < 2.0.0"
  backend "gcs" {
    bucket = "roybench-tfstate-672373544179"
    prefix = "t4code-com/prod"
  }


  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
}
