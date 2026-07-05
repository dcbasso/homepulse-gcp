# homepulse-gcp

Home internet connection monitor — GCP implementation.

Runs a speedtest on a local machine on a schedule, stores results in Firestore, sends email alerts on outages, and exposes a web dashboard for historical analysis.

## Monorepo Structure

| Path | Language | Description |
|---|---|---|
| [client/homepulse-client/](client/homepulse-client/) | Rust | Local agent — runs speedtest CLI and writes results to Firestore |
| [frontend/homepulse-web/](frontend/homepulse-web/) | Angular + TypeScript | Dashboard SPA hosted on Firebase Hosting |
| [backend/homepulse-notification-server/](backend/homepulse-notification-server/) | Python + Terraform | Cloud Function for alerting + GCP infrastructure |

## Architecture

```
[Local machine]                        [GCP / Firebase]
 client/homepulse-client (Rust)
  └─ runs speedtest CLI   ──────►  Firestore (speedtest_results)
                                        │
                               Cloud Scheduler (every N min)
                                        │
                    backend/homepulse-notification-server (Python)
                                        └─ Gmail API → alert / recovery email
                                        │
                    frontend/homepulse-web (Angular)
                                        └─ Firebase Hosting
                                        └─ Firebase Auth (Google Sign-In)
                                        └─ reads Firestore directly (client SDK)
```

## Getting Started

See the setup guide in each subproject:

- [client/homepulse-client/](client/homepulse-client/) — Rust client setup and config
- [backend/homepulse-notification-server/function/](backend/homepulse-notification-server/function/) — Cloud Function deployment
- [backend/homepulse-notification-server/terraform/](backend/homepulse-notification-server/terraform/) — GCP infra provisioning
- [frontend/homepulse-web/](frontend/homepulse-web/) — Angular dashboard setup
