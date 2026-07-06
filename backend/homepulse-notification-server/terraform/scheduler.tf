# ---------------------------------------------------------------------------
# Cloud Scheduler job — triggers the Cloud Function every 5 minutes
#
# Uses OIDC authentication so the function can verify the caller identity
# without exposing the endpoint publicly beyond the IAM invoker binding.
#
# Note: changing check_interval_minutes in the Settings UI does NOT update
# this schedule automatically. Changing the cadence requires re-running
# `terraform apply` with a new variable value (or editing manually in Console).
# ---------------------------------------------------------------------------

resource "google_cloud_scheduler_job" "check_internet_status" {
  name        = "check-internet-status"
  description = "Triggers the Cloud Function to check for recent heartbeat data"
  schedule    = "*/5 * * * *"
  time_zone   = "America/Sao_Paulo"
  region      = var.region

  http_target {
    http_method = "POST"
    uri         = google_cloudfunctions2_function.check_internet_status.service_config[0].uri

    # OIDC token ensures Cloud Run (Gen 2 functions run on Cloud Run) accepts the request.
    oidc_token {
      service_account_email = var.sa_email
      audience              = google_cloudfunctions2_function.check_internet_status.service_config[0].uri
    }
  }
}
