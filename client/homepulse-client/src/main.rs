mod config;
mod firestore;
mod speedtest;

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use tracing::{error, info};

/// Command-line arguments for the homepulse client.
#[derive(Parser, Debug)]
#[command(name = "homepulse-client")]
#[command(about = "Runs a speedtest and writes the result to Firestore")]
struct Args {
    /// Path to the config.json file.
    #[arg(short, long, default_value = "config.json")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args = Args::parse();
    let cfg = config::Config::load(&args.config)?;

    info!("Running speedtest...");
    let result = match speedtest::run(&cfg.speedtest) {
        Ok(r) => r,
        Err(e) => {
            error!("Speedtest failed: {:?}", e);
            return Err(e);
        }
    };

    info!(
        "Result: download={:.2} Mbps upload={:.2} Mbps ping={:.1} ms",
        result.download_mbps, result.upload_mbps, result.ping_ms
    );

    info!("Authenticating with Service Account...");
    let token = firestore::get_access_token(&cfg.gcp).await?;

    info!("Writing result to Firestore...");
    firestore::append_document(&cfg.gcp, &token, &result).await?;

    info!("Done.");
    Ok(())
}
