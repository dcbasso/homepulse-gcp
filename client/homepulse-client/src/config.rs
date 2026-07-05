use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::Path;

/// Root configuration loaded from `config.json`.
///
/// Only the fields consumed by this binary are declared here; other fields
/// present in the JSON file (e.g. `interval_minutes`, `log`) are ignored by serde.
#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub speedtest: SpeedtestConfig,
    pub gcp: FirestoreConfig,
}

/// Settings for the speedtest CLI binary.
#[derive(Debug, Deserialize, Clone)]
pub struct SpeedtestConfig {
    pub binary_path: String,
    pub timeout_seconds: u64,
}

/// Firestore connection settings (project ID and target collection).
#[derive(Debug, Deserialize, Clone)]
pub struct FirestoreConfig {
    pub service_account_key_path: String,
    pub project_id: String,
    pub collection: String,
}

/// Parsed representation of a Google Service Account JSON key file.
///
/// The structure matches the file produced by GCP Console when creating a
/// Service Account key of type "JSON".
#[derive(Debug, Deserialize, Clone)]
pub struct ServiceAccountKey {
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

impl Config {
    /// Loads and deserializes the configuration from the given JSON file path.
    ///
    /// # Errors
    /// Returns an error if the file cannot be read or if the JSON is malformed.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("Failed to read config at {:?}", path))?;
        let config: Config = serde_json::from_str(&raw)
            .context("Failed to parse config.json")?;
        Ok(config)
    }
}

impl ServiceAccountKey {
    /// Loads and deserializes a Service Account key from the given file path.
    ///
    /// # Errors
    /// Returns an error if the file cannot be read or if the JSON is malformed.
    pub fn load(path: &str) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("Failed to read service account key at {}", path))?;
        let key: ServiceAccountKey = serde_json::from_str(&raw)
            .context("Failed to parse service-account.json")?;
        Ok(key)
    }
}
