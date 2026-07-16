"""Cloud Function — Internet Monitor.

Triggered by Cloud Scheduler every 5 minutes. Reads the latest heartbeat
document from Firestore, compares its timestamp against a configurable
threshold, and sends Gmail alerts on state transitions (up→down, down→up).
Incident records are persisted in Firestore.
"""

import base64
import email.mime.text
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

import functions_framework
import requests
from google.cloud import firestore
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# The Cloud Run Python runtime pre-configures the root logger with its own
# handler, making `logging.basicConfig()` a no-op (it only takes effect when
# the root logger has no handlers yet). Attaching an explicit handler here
# guarantees INFO-level logs are emitted regardless of that pre-existing setup.
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.propagate = False
_handler = logging.StreamHandler(sys.stdout)
_handler.setLevel(logging.INFO)
logger.addHandler(_handler)

COLLECTION_HEARTBEAT = "heartbeats"
COLLECTION_STATE = "monitor_state"
COLLECTION_CONFIG = "monitor_config"
COLLECTION_INCIDENTS = "incidents"

# Number of consecutive checks that must see a stale heartbeat before an
# outage is confirmed and an alert is sent. Debounces single-sample false
# positives (e.g. a transient Firestore read anomaly) without meaningfully
# delaying detection of a real outage (adds at most one scheduler interval).
DOWN_CONFIRMATION_CHECKS = 2
STATE_DOC = "current"
CONFIG_DOC = "current"

DEFAULT_MAX_MINUTES = 5
DEFAULT_ALERT_EMAIL = os.environ.get("ALERT_EMAIL", "")
DEFAULT_SUBJECT_DOWN = "[homepulse] Internet is down"
DEFAULT_SUBJECT_UP = "[homepulse] Internet is back"
DEFAULT_BODY_DOWN = (
    "No heartbeat received since ${DATETIME_DOWN}.\n\n"
    "Hi ${NAME}, you will receive another email once the internet comes back."
)
DEFAULT_BODY_UP = (
    "Hi ${NAME}, the internet is back!\n\n"
    "Down at: ${DATETIME_DOWN}\nRecovered at: ${DATETIME_UP}\nTotal downtime: ${TOTAL_TIME} min"
)

TELEGRAM_API_BASE = "https://api.telegram.org"

_gmail_service = None


@dataclass
class MonitorConfig:
    """Monitoring configuration loaded from Firestore.

    Attributes:
        max_minutes: Minutes without heartbeat data before an outage is declared.
        recipients: List of dicts with 'email' and 'name' keys for alert recipients.
        subject_down: Email subject used when the internet goes down.
        subject_up: Email subject used when the internet recovers.
        body_down: Body template for the outage alert. Supports ${NAME} and ${DATETIME_DOWN}.
        body_up: Body template for the recovery alert. Supports ${NAME}, ${DATETIME_DOWN},
            ${DATETIME_UP}, and ${TOTAL_TIME}.
        notify_on_down: Whether to send email alerts when an outage is detected.
        notify_on_recovery: Whether to send email alerts when the internet recovers.
        telegram_recipients: List of dicts with 'name', 'bot_token', and 'chat_id' keys
            for Telegram alert recipients.
        notify_telegram_on_down: Whether to send Telegram alerts when an outage is detected.
        notify_telegram_on_recovery: Whether to send Telegram alerts when the internet recovers.
    """

    max_minutes: int
    recipients: list[dict]
    subject_down: str
    subject_up: str
    body_down: str
    body_up: str
    notify_on_down: bool
    notify_on_recovery: bool
    telegram_recipients: list[dict]
    notify_telegram_on_down: bool
    notify_telegram_on_recovery: bool


def _get_firestore_client() -> firestore.Client:
    """Returns a Firestore client using the default application credentials.

    Reads GCP_PROJECT_ID and FIRESTORE_DATABASE from environment variables.
    FIRESTORE_DATABASE defaults to "(default)" if not set.

    Returns:
        An authenticated Firestore client for the configured GCP project.
    """
    project_id = os.environ["GCP_PROJECT_ID"]
    database = os.environ.get("FIRESTORE_DATABASE", "(default)")
    return firestore.Client(project=project_id, database=database)


def _load_monitor_config(db: firestore.Client) -> MonitorConfig:
    """Reads monitoring configuration from Firestore, falling back to env var defaults.

    Applies lazy migration: if `alert_emails` is absent, falls back to the legacy
    `alert_email` field, then to the ALERT_EMAIL environment variable.

    Args:
        db: Authenticated Firestore client.

    Returns:
        A MonitorConfig populated from Firestore or defaults.
    """
    doc = db.collection(COLLECTION_CONFIG).document(CONFIG_DOC).get()
    if doc.exists:
        data = doc.to_dict()
        max_minutes = int(data.get("max_minutes_without_data", DEFAULT_MAX_MINUTES))

        alert_emails = data.get("alert_emails") or []
        if not alert_emails:
            legacy = data.get("alert_email", DEFAULT_ALERT_EMAIL)
            alert_emails = [legacy] if legacy else []

        recipient_names = data.get("recipient_names") or {}
        recipients = [
            {"email": e, "name": recipient_names.get(e, "")}
            for e in alert_emails
        ]
        if not recipients:
            recipients = [{"email": DEFAULT_ALERT_EMAIL, "name": ""}]

        telegram_recipients = [
            {
                "name": r.get("name", ""),
                "bot_token": r.get("bot_token", ""),
                "chat_id": r.get("chat_id", ""),
            }
            for r in (data.get("telegram_recipients") or [])
        ]

        return MonitorConfig(
            max_minutes=max_minutes,
            recipients=recipients,
            subject_down=data.get("email_subject_down") or DEFAULT_SUBJECT_DOWN,
            subject_up=data.get("email_subject_up") or DEFAULT_SUBJECT_UP,
            body_down=data.get("email_body_down") or DEFAULT_BODY_DOWN,
            body_up=data.get("email_body_up") or DEFAULT_BODY_UP,
            notify_on_down=bool(data.get("notify_on_down", True)),
            notify_on_recovery=bool(data.get("notify_on_recovery", True)),
            telegram_recipients=telegram_recipients,
            notify_telegram_on_down=bool(data.get("notify_telegram_on_down", True)),
            notify_telegram_on_recovery=bool(data.get("notify_telegram_on_recovery", True)),
        )

    logger.warning("monitor_config/current not found — using env var defaults")
    max_minutes = int(os.environ.get("MAX_MINUTES_WITHOUT_DATA", DEFAULT_MAX_MINUTES))
    return MonitorConfig(
        max_minutes=max_minutes,
        recipients=[{"email": DEFAULT_ALERT_EMAIL, "name": ""}],
        subject_down=DEFAULT_SUBJECT_DOWN,
        subject_up=DEFAULT_SUBJECT_UP,
        body_down=DEFAULT_BODY_DOWN,
        body_up=DEFAULT_BODY_UP,
        notify_on_down=True,
        notify_on_recovery=True,
        telegram_recipients=[],
        notify_telegram_on_down=True,
        notify_telegram_on_recovery=True,
    )


def _resolve_template(template: str, replacements: dict[str, str]) -> str:
    """Substitutes ${KEY} placeholders in a template string.

    Args:
        template: Template string containing ${KEY} placeholders.
        replacements: Map of placeholder key to its replacement value.

    Returns:
        The template with all known placeholders substituted.
    """
    result = template
    for key, value in replacements.items():
        result = result.replace(f"${{{key}}}", value)
    return result


def _get_latest_heartbeat_timestamp(db: firestore.Client) -> datetime | None:
    """Queries the most recent heartbeat document from Firestore.

    Args:
        db: Authenticated Firestore client.

    Returns:
        The UTC timestamp of the latest document, or None if the collection is empty.
    """
    docs = (
        db.collection(COLLECTION_HEARTBEAT)
        .order_by("timestamp", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )
    for doc in docs:
        data = doc.to_dict()
        ts = data.get("timestamp")
        if isinstance(ts, datetime):
            return ts.astimezone(timezone.utc)
        if isinstance(ts, str):
            return datetime.fromisoformat(ts).astimezone(timezone.utc)
    return None


def _read_monitor_state(db: firestore.Client) -> tuple[bool, int]:
    """Reads the current internet-down state from Firestore.

    Args:
        db: Authenticated Firestore client.

    Returns:
        A tuple of (internet_down, consecutive_down_checks). internet_down is
        True if the internet was previously flagged as down (and an alert
        already sent). consecutive_down_checks counts how many checks in a
        row have seen a stale heartbeat without yet reaching
        DOWN_CONFIRMATION_CHECKS (used to debounce single-sample anomalies).
    """
    doc = db.collection(COLLECTION_STATE).document(STATE_DOC).get()
    if doc.exists:
        data = doc.to_dict()
        return (
            bool(data.get("internet_down", False)),
            int(data.get("consecutive_down_checks", 0)),
        )
    return False, 0


def _write_monitor_state(db: firestore.Client, internet_down: bool, consecutive_down_checks: int = 0) -> None:
    """Persists a confirmed internet-down/up state transition to Firestore.

    Args:
        db: Authenticated Firestore client.
        internet_down: True if the internet is now considered down.
        consecutive_down_checks: Value to store for the running debounce counter
            (0 on recovery, since the counter restarts from scratch afterwards).
    """
    now = datetime.now(timezone.utc)
    field_name = "last_down_alert_at" if internet_down else "last_recovery_alert_at"
    db.collection(COLLECTION_STATE).document(STATE_DOC).set(
        {
            "internet_down": internet_down,
            "consecutive_down_checks": consecutive_down_checks,
            field_name: now,
        },
        merge=True,
    )


def _write_down_check_counter(db: firestore.Client, consecutive_down_checks: int) -> None:
    """Persists the running count of consecutive stale-heartbeat checks.

    Used while a potential outage has not yet been confirmed (has not reached
    DOWN_CONFIRMATION_CHECKS), so no alert-related fields are touched.

    Args:
        db: Authenticated Firestore client.
        consecutive_down_checks: The updated counter value.
    """
    db.collection(COLLECTION_STATE).document(STATE_DOC).set(
        {"consecutive_down_checks": consecutive_down_checks},
        merge=True,
    )


def _create_incident(db: firestore.Client) -> str:
    """Creates a new incident document marking the start of an outage.

    Args:
        db: Authenticated Firestore client.

    Returns:
        The auto-generated document ID of the created incident.
    """
    now = datetime.now(timezone.utc)
    _, ref = db.collection(COLLECTION_INCIDENTS).add(
        {"started_at": now, "recovered_at": None, "duration_minutes": None}
    )
    return ref.id


def _close_latest_incident(db: firestore.Client) -> tuple[datetime | None, int | None]:
    """Updates the most recent open incident with its recovery time and duration.

    Queries the most recent incident by started_at and closes it if still open.
    Avoids a composite index by filtering recovered_at in Python.

    Args:
        db: Authenticated Firestore client.

    Returns:
        A tuple of (started_at_utc, duration_minutes). Both are None if no open incident
        was found or the started_at field was missing.
    """
    docs = (
        db.collection(COLLECTION_INCIDENTS)
        .order_by("started_at", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )
    now = datetime.now(timezone.utc)
    for doc in docs:
        data = doc.to_dict()
        if data.get("recovered_at") is not None:
            logger.warning("Latest incident %s is already closed — skipping", doc.id)
            return None, None
        started_at = data.get("started_at")
        started_at_utc = None
        duration = None
        if isinstance(started_at, datetime):
            started_at_utc = started_at.astimezone(timezone.utc)
            duration = round((now - started_at_utc).total_seconds() / 60)
        doc.reference.update({"recovered_at": now, "duration_minutes": duration})
        logger.warning("Incident %s closed — duration: %s min", doc.id, duration)
        return started_at_utc, duration
    return None, None


def _build_gmail_service():
    """Builds an authenticated Gmail API service using OAuth2 secrets from env vars.

    Reads GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN from
    environment variables (injected from Secret Manager by Cloud Functions).

    Returns:
        An authorized Gmail API Resource object.
    """
    global _gmail_service
    if _gmail_service is not None:
        return _gmail_service

    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_REFRESH_TOKEN"],
        client_id=os.environ["GMAIL_CLIENT_ID"],
        client_secret=os.environ["GMAIL_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/gmail.send"],
    )
    creds.refresh(Request())
    _gmail_service = build("gmail", "v1", credentials=creds)
    return _gmail_service


def _send_email(to: str, subject: str, body: str) -> None:
    """Sends an email via the Gmail API.

    Args:
        to: Recipient email address.
        subject: Email subject line.
        body: Plain-text email body.
    """
    global _gmail_service
    message = email.mime.text.MIMEText(body)
    message["to"] = to
    message["subject"] = subject
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    try:
        service = _build_gmail_service()
        service.users().messages().send(userId="me", body={"raw": raw}).execute()
    except Exception:
        # Connection may be stale — discard cached service and retry once with a fresh one.
        _gmail_service = None
        service = _build_gmail_service()
        service.users().messages().send(userId="me", body={"raw": raw}).execute()
    logger.info("Email sent to %s — subject: %s", to, subject)


def _send_down_alert(
    recipient: dict,
    last_timestamp: datetime,
    diff_minutes: float,
    subject: str,
    body_template: str,
) -> None:
    """Sends an internet-down alert email to a single recipient.

    Resolves ${NAME} and ${DATETIME_DOWN} placeholders in the body template.

    Args:
        recipient: Dict with 'email' and 'name' keys.
        last_timestamp: UTC timestamp of the last received heartbeat record.
        diff_minutes: Minutes elapsed since the last record.
        subject: Email subject line.
        body_template: Body template string with optional placeholders.
    """
    body = _resolve_template(body_template, {
        "NAME": recipient["name"],
        "DATETIME_DOWN": last_timestamp.strftime("%Y-%m-%d %H:%M:%S UTC"),
    })
    _send_email(to=recipient["email"], subject=subject, body=body)


def _send_recovery_alert(
    recipient: dict,
    recovery_timestamp: datetime,
    started_at: datetime | None,
    duration_minutes: int | None,
    subject: str,
    body_template: str,
) -> None:
    """Sends an internet-recovery alert email to a single recipient.

    Resolves ${NAME}, ${DATETIME_DOWN}, ${DATETIME_UP}, and ${TOTAL_TIME}
    placeholders in the body template.

    Args:
        recipient: Dict with 'email' and 'name' keys.
        recovery_timestamp: UTC timestamp when the internet was detected as recovered.
        started_at: UTC timestamp when the outage started, or None if unavailable.
        duration_minutes: Total outage duration in minutes, or None if unavailable.
        subject: Email subject line.
        body_template: Body template string with optional placeholders.
    """
    datetime_down = (
        started_at.strftime("%Y-%m-%d %H:%M:%S UTC") if started_at else "unknown"
    )
    total_time = str(duration_minutes) if duration_minutes is not None else "unknown"
    body = _resolve_template(body_template, {
        "NAME": recipient["name"],
        "DATETIME_DOWN": datetime_down,
        "DATETIME_UP": recovery_timestamp.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "TOTAL_TIME": total_time,
    })
    _send_email(to=recipient["email"], subject=subject, body=body)


def _send_telegram_message(bot_token: str, chat_id: str, text: str) -> None:
    """Sends a text message via the Telegram Bot API.

    Args:
        bot_token: Telegram bot token obtained from @BotFather.
        chat_id: Telegram chat ID (or @channelusername) to send the message to.
        text: Plain-text message body (Telegram's sendMessage has no subject field).
    """
    url = f"{TELEGRAM_API_BASE}/bot{bot_token}/sendMessage"
    response = requests.post(url, json={"chat_id": chat_id, "text": text}, timeout=10)
    response.raise_for_status()
    logger.info("Telegram message sent to chat_id %s", chat_id)


def _send_telegram_down_alert(
    recipient: dict,
    last_timestamp: datetime,
    subject: str,
    body_template: str,
) -> None:
    """Sends an internet-down alert via Telegram to a single recipient.

    Resolves ${NAME} and ${DATETIME_DOWN} placeholders in the body template, then
    combines subject and body into a single message since Telegram has no subject field.

    Args:
        recipient: Dict with 'name', 'bot_token', and 'chat_id' keys.
        last_timestamp: UTC timestamp of the last received heartbeat record.
        subject: Subject line (same value used for the email subject).
        body_template: Body template string with optional placeholders.
    """
    body = _resolve_template(body_template, {
        "NAME": recipient["name"],
        "DATETIME_DOWN": last_timestamp.strftime("%Y-%m-%d %H:%M:%S UTC"),
    })
    _send_telegram_message(recipient["bot_token"], recipient["chat_id"], f"{subject}\n\n{body}")


def _send_telegram_recovery_alert(
    recipient: dict,
    recovery_timestamp: datetime,
    started_at: datetime | None,
    duration_minutes: int | None,
    subject: str,
    body_template: str,
) -> None:
    """Sends an internet-recovery alert via Telegram to a single recipient.

    Resolves ${NAME}, ${DATETIME_DOWN}, ${DATETIME_UP}, and ${TOTAL_TIME} placeholders
    in the body template, then combines subject and body into a single message since
    Telegram has no subject field.

    Args:
        recipient: Dict with 'name', 'bot_token', and 'chat_id' keys.
        recovery_timestamp: UTC timestamp when the internet was detected as recovered.
        started_at: UTC timestamp when the outage started, or None if unavailable.
        duration_minutes: Total outage duration in minutes, or None if unavailable.
        subject: Subject line (same value used for the email subject).
        body_template: Body template string with optional placeholders.
    """
    datetime_down = (
        started_at.strftime("%Y-%m-%d %H:%M:%S UTC") if started_at else "unknown"
    )
    total_time = str(duration_minutes) if duration_minutes is not None else "unknown"
    body = _resolve_template(body_template, {
        "NAME": recipient["name"],
        "DATETIME_DOWN": datetime_down,
        "DATETIME_UP": recovery_timestamp.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "TOTAL_TIME": total_time,
    })
    _send_telegram_message(recipient["bot_token"], recipient["chat_id"], f"{subject}\n\n{body}")


@functions_framework.http
def check_internet_status(request) -> tuple[str, int]:
    """Check whether recent heartbeat data exists and send alerts if needed.

    Reads the latest document from Firestore, compares its timestamp against
    the configured threshold, and sends Gmail and/or Telegram alerts on state
    transitions (down→up or up→down). Incident documents are created and closed
    accordingly. Alerts are sent to all configured recipients on each enabled
    channel, with per-recipient name substitution.

    Args:
        request: HTTP request object provided by Cloud Functions runtime.

    Returns:
        A tuple of (response_body, http_status_code).
    """
    try:
        db = _get_firestore_client()
        config = _load_monitor_config(db)

        last_timestamp = _get_latest_heartbeat_timestamp(db)
        if last_timestamp is None:
            logger.warning("No heartbeat documents found in Firestore — skipping check")
            return "No data available", 200

        now = datetime.now(timezone.utc)
        diff_minutes = (now - last_timestamp).total_seconds() / 60

        logger.info(
            "Last record: %s — %.1f min ago (threshold: %d min)",
            last_timestamp.strftime("%Y-%m-%d %H:%M:%S UTC"),
            diff_minutes,
            config.max_minutes,
        )

        internet_was_down, consecutive_down_checks = _read_monitor_state(db)

        if diff_minutes > config.max_minutes:
            if internet_was_down:
                logger.info("Internet still DOWN — no duplicate alert sent")
            else:
                consecutive_down_checks += 1
                if consecutive_down_checks >= DOWN_CONFIRMATION_CHECKS:
                    logger.info("Internet appears DOWN — creating incident and sending alerts")
                    _create_incident(db)
                    _write_monitor_state(db, internet_down=True, consecutive_down_checks=consecutive_down_checks)
                    if config.notify_on_down:
                        try:
                            for recipient in config.recipients:
                                _send_down_alert(
                                    recipient=recipient,
                                    last_timestamp=last_timestamp,
                                    diff_minutes=diff_minutes,
                                    subject=config.subject_down,
                                    body_template=config.body_down,
                                )
                        except Exception as e:
                            logger.error("Email down-alert failed: %s", e)
                    if config.notify_telegram_on_down:
                        try:
                            for recipient in config.telegram_recipients:
                                _send_telegram_down_alert(
                                    recipient=recipient,
                                    last_timestamp=last_timestamp,
                                    subject=config.subject_down,
                                    body_template=config.body_down,
                                )
                        except Exception as e:
                            logger.error("Telegram down-alert failed: %s", e)
                else:
                    logger.info(
                        "Possible outage detected (%d/%d consecutive checks) — awaiting confirmation before alerting",
                        consecutive_down_checks,
                        DOWN_CONFIRMATION_CHECKS,
                    )
                    _write_down_check_counter(db, consecutive_down_checks)
        else:
            if internet_was_down:
                logger.info("Internet is BACK — closing incident and sending recovery alerts")
                started_at, duration_minutes = _close_latest_incident(db)
                _write_monitor_state(db, internet_down=False, consecutive_down_checks=0)
                if config.notify_on_recovery:
                    try:
                        for recipient in config.recipients:
                            _send_recovery_alert(
                                recipient=recipient,
                                recovery_timestamp=last_timestamp,
                                started_at=started_at,
                                duration_minutes=duration_minutes,
                                subject=config.subject_up,
                                body_template=config.body_up,
                            )
                    except Exception as e:
                        logger.error("Email recovery-alert failed: %s", e)
                if config.notify_telegram_on_recovery:
                    try:
                        for recipient in config.telegram_recipients:
                            _send_telegram_recovery_alert(
                                recipient=recipient,
                                recovery_timestamp=last_timestamp,
                                started_at=started_at,
                                duration_minutes=duration_minutes,
                                subject=config.subject_up,
                                body_template=config.body_up,
                            )
                    except Exception as e:
                        logger.error("Telegram recovery-alert failed: %s", e)
            else:
                if consecutive_down_checks:
                    _write_down_check_counter(db, 0)
                logger.info("Internet is UP — nothing to do")

        return "OK", 200

    except Exception as exc:
        logger.exception("Unexpected error during internet status check: %s", exc)
        return f"Internal error: {exc}", 500


def _resolve_caller_ip(request) -> str:
    """Resolves the real caller IP address from an incoming HTTP request.

    Cloud Functions Gen2 runs on Cloud Run behind the Google Front End, so
    `request.remote_addr` reflects the GFE's internal address rather than the
    original client. The actual caller IP is the first entry in the
    comma-separated `X-Forwarded-For` header. Falls back to
    `request.remote_addr` if the header is absent.

    Args:
        request: HTTP request object provided by Cloud Functions runtime.

    Returns:
        The resolved caller IP address, or an empty string if unavailable.
    """
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.remote_addr or ""


@functions_framework.http
def whoami(request) -> tuple[dict, int]:
    """Reports the caller's public IP address.

    Public, unauthenticated endpoint intended for the Rust client's heartbeat
    check — it lets the client discover the WAN IP it is currently reaching
    GCP from. Returns no sensitive data.

    Args:
        request: HTTP request object provided by Cloud Functions runtime.

    Returns:
        A tuple of (response_body, http_status_code), where response_body is
        a JSON-serializable dict of the form {"ip": "<caller's IP>"}.
    """
    ip = _resolve_caller_ip(request)
    return {"ip": ip}, 200
