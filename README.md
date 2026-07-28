# homepulse-gcp

Home internet connection monitor — GCP implementation.

Runs a speedtest on a local machine on a schedule, stores results in Firestore, sends email alerts on outages, and exposes a web dashboard for historical analysis.

Project page: https://www.dantebasso.com.br/opensource/homepulse-gcp

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

## Gmail OAuth — Publishing Status Gotcha

The Cloud Function sends outage/recovery emails via the Gmail API using a long-lived OAuth2 refresh token stored in Secret Manager (`gmail-refresh-token`).

**The OAuth consent screen (GCP Console → APIs & Services → OAuth consent screen, aka "Google Auth Platform → Audience") must be in `In production` publishing status, not `Testing`.** While in `Testing`, Google expires refresh tokens after 7 days — this silently breaks email alerts while leaving other channels (e.g. Telegram) working, since they don't depend on this token. That mismatch is usually the first symptom anyone notices.

Symptom in Cloud Function logs: `Email down-alert failed: ('invalid_grant: Bad Request', ...)`.

**Fix once, permanently:** GCP Console → project → OAuth consent screen → set **Publishing status** to **"In production"** (click "Publish app"). The `gmail.send` scope is "sensitive" (not "restricted"), so a small/personal-use app can publish without Google verification — end users will just see an "unverified app" warning during consent, which is expected and safe to bypass ("Advanced" → "Go to (app) (unsafe)").

**Regenerating the refresh token** (needed once at initial setup, or again if it's ever revoked/expired):

1. In GCP Console → APIs & Services → Clients, download the OAuth2 client credentials JSON for the Gmail API client and save it as `client_secret.json` inside `backend/homepulse-notification-server/deploy/` (this file is gitignored — never commit it).
2. Install the OAuth flow dependency and run the helper script:
   ```bash
   cd backend/homepulse-notification-server/deploy
   pip install --user google-auth-oauthlib
   python3 get_refresh_token.py
   ```
   A browser window opens — sign in with the alert-sending Google account and grant the `gmail.send` permission. The script prints the new `refresh_token`, `client_id`, and `client_secret`.

   If `get_refresh_token.py` is missing from your local `deploy/` folder (it lives there, which is gitignored), recreate it:
   ```python
   """One-time script to obtain the Gmail OAuth2 refresh token.

   Usage: place client_secret.json in this same folder, then run this script.
   A browser window opens — sign in and grant permission. Copy the printed
   refresh_token into Secret Manager (see README "Gmail OAuth" section).
   """
   import os
   from google_auth_oauthlib.flow import InstalledAppFlow

   SCOPES = ["https://www.googleapis.com/auth/gmail.send"]
   SECRET_FILE = os.path.join(os.path.dirname(__file__), "client_secret.json")

   def main() -> None:
       flow = InstalledAppFlow.from_client_secrets_file(SECRET_FILE, scopes=SCOPES)
       creds = flow.run_local_server(port=0)
       print(f"refresh_token: {creds.refresh_token}")
       print(f"client_id:     {creds.client_id}")
       print(f"client_secret: {creds.client_secret}")

   if __name__ == "__main__":
       main()
   ```
3. Store the new token in Secret Manager:
   ```bash
   echo -n "NEW_REFRESH_TOKEN" | gcloud secrets versions add gmail-refresh-token --project=<PROJECT_ID> --data-file=-
   ```
4. Force the Cloud Function to pick up the new value — the secret is injected as an env var only when a container instance starts, and the Gmail service is cached in memory per warm instance:
   ```bash
   gcloud functions deploy check-internet-status --project=<PROJECT_ID> --region=<REGION> \
     --source=backend/homepulse-notification-server/function \
     --update-secrets=GMAIL_REFRESH_TOKEN=gmail-refresh-token:latest
   ```
