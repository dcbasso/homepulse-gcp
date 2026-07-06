use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// Subset of the JSON body returned by the `whoami` GCP endpoint.
#[derive(Debug, Deserialize)]
struct WhoamiResponse {
    ip: String,
}

/// Fetches the caller's public IP address from the `whoami` GCP endpoint.
///
/// The endpoint is public and requires no authentication: the write to
/// Firestore (via a valid Service Account token) is what proves identity,
/// not this lookup.
///
/// # Arguments
/// * `url` - Full URL of the `whoami` endpoint.
///
/// # Errors
/// Returns an error if the HTTP request fails or the response body cannot be
/// parsed as `{"ip": "..."}`.
pub async fn fetch_external_ip(url: &str) -> Result<String> {
    let response = reqwest::get(url)
        .await
        .context("Failed to call the whoami endpoint")?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        bail!("whoami endpoint returned an error ({}): {}", status, body);
    }

    let parsed: WhoamiResponse = serde_json::from_str(&body)
        .with_context(|| format!("Unexpected response from whoami endpoint: {}", body))?;

    Ok(parsed.ip)
}
