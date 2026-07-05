# ---------------------------------------------------------------------------
# Input variables
#
# Values are supplied via terraform.tfvars (gitignored).
# See terraform.tfvars.example for a template.
# ---------------------------------------------------------------------------

variable "project_id" {
  type        = string
  description = "GCP project ID (e.g. REDACTED_PROJECT_ID)"
}

variable "region" {
  type        = string
  default     = "southamerica-east1"
  description = "GCP region for Cloud Function and Cloud Scheduler"
}

variable "alert_email" {
  type        = string
  description = "Gmail address that receives up/down alert emails"
}

variable "sa_email" {
  type        = string
  description = "Service Account email created during pre-requisites setup"
}

variable "max_minutes_without_data" {
  type        = number
  default     = 45
  description = "Minutes without a Firestore document before an alert is triggered"
}
