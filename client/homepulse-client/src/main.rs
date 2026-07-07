mod config;
mod firestore;
mod speedtest;
mod whoami;

use anyhow::Result;
use clap::Parser;
use config::Config;
use firestore::TokenCache;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::interval;
use tracing::{error, info};

/// Number of seconds in a minute, used to convert configured intervals to [`Duration`]s.
const SECONDS_PER_MINUTE: u64 = 60;

/// Command-line arguments for the homepulse client.
#[derive(Parser, Debug)]
#[command(name = "homepulse-client")]
#[command(about = "Runs a liveness heartbeat loop and a speedtest loop, writing both to Firestore")]
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
    let cfg = Config::load(&args.config)?;
    let token_cache = firestore::new_token_cache();

    let heartbeat_task = run_heartbeat_loop(cfg.clone(), token_cache.clone());
    let speedtest_task = run_speedtest_loop(cfg, token_cache);

    tokio::join!(heartbeat_task, speedtest_task);
    Ok(())
}

/// Runs the liveness heartbeat loop forever, ticking every
/// `cfg.heartbeat.interval_minutes` minutes.
///
/// Each tick resolves the public IP via the `whoami` endpoint, obtains a
/// (possibly cached) OAuth2 access token, and writes a heartbeat document to
/// Firestore. Any failure is logged and the loop continues to the next tick
/// rather than aborting the process.
///
/// # Arguments
/// * `cfg` - Full application configuration.
/// * `token_cache` - Shared OAuth2 token cache, reused with the speedtest loop.
async fn run_heartbeat_loop(cfg: Config, token_cache: TokenCache) {
    let period = Duration::from_secs(cfg.heartbeat.interval_minutes * SECONDS_PER_MINUTE);
    let mut ticker = interval(period);

    loop {
        ticker.tick().await;
        if let Err(e) = run_heartbeat_once(&cfg, &token_cache).await {
            error!("Heartbeat tick failed: {:?}", e);
        }
    }
}

/// Performs a single heartbeat tick: resolve public IP, authenticate, write to Firestore.
///
/// # Errors
/// Returns an error if authentication or the Firestore write fails. A failed
/// IP lookup does not cause an error; `None` is passed through instead.
async fn run_heartbeat_once(cfg: &Config, token_cache: &TokenCache) -> Result<()> {
    let external_ip = match whoami::fetch_external_ip(&cfg.heartbeat.whoami_url).await {
        Ok(ip) => Some(ip),
        Err(e) => {
            error!("Failed to resolve external IP: {:?}", e);
            None
        }
    };

    let token = firestore::get_cached_access_token(&cfg.gcp, token_cache).await?;
    firestore::append_heartbeat(&cfg.gcp, &cfg.heartbeat.collection, &token, external_ip.as_deref()).await?;

    info!("Heartbeat written (external_ip={:?})", external_ip);
    Ok(())
}

/// Runs the speedtest loop forever, ticking every `cfg.speedtest.interval_minutes` minutes.
///
/// Each tick runs the Ookla `speedtest` CLI, obtains a (possibly cached)
/// OAuth2 access token, and writes the result to Firestore. Any failure is
/// logged and the loop continues to the next tick rather than aborting the
/// process.
///
/// # Arguments
/// * `cfg` - Full application configuration.
/// * `token_cache` - Shared OAuth2 token cache, reused with the heartbeat loop.
async fn run_speedtest_loop(cfg: Config, token_cache: TokenCache) {
    let period = Duration::from_secs(cfg.speedtest.interval_minutes * SECONDS_PER_MINUTE);
    let mut ticker = interval(period);

    loop {
        ticker.tick().await;
        if let Err(e) = run_speedtest_once(&cfg, &token_cache).await {
            error!("Speedtest tick failed: {:?}", e);
        }
    }
}

/// Performs a single speedtest tick: run Ookla, authenticate, write to Firestore.
///
/// # Errors
/// Returns an error if the speedtest binary fails, authentication fails, or
/// the Firestore write fails.
async fn run_speedtest_once(cfg: &Config, token_cache: &TokenCache) -> Result<()> {
    info!("Running speedtest...");
    let result = speedtest::run(&cfg.speedtest)?;

    info!(
        "Result: download={:.2} Mbps upload={:.2} Mbps ping={:.1} ms",
        result.download_mbps, result.upload_mbps, result.ping_ms
    );

    let token = firestore::get_cached_access_token(&cfg.gcp, token_cache).await?;
    firestore::append_document(&cfg.gcp, &cfg.speedtest.collection, &token, &result).await?;

    info!("Speedtest result written.");
    Ok(())
}
