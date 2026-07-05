"""Cloud Function — Internet Monitor.

Triggered by Cloud Scheduler every 5 minutes. Reads the latest speedtest
document from Firestore, compares its timestamp against a configurable
threshold, and sends Gmail alerts on state transitions (up→down, down→up).
Incident records are persisted in Firestore.
"""

import base64
import email.mime.text
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

import functions_framework
from google.cloud import firestore
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

COLLECTION_SPEEDTEST = "speedtest_results"
COLLECTION_STATE = "monitor_state"
COLLECTION_CONFIG = "monitor_config"
COLLECTION_INCIDENTS = "incidents"
STATE_DOC = "current"
CONFIG_DOC = "current"

DEFAULT_MAX_MINUTES = 10
DEFAULT_ALERT_EMAIL = os.environ.get("ALERT_EMAIL", "")
DEFAULT_SUBJECT_DOWN = "[homepulse] Internet is down"
DEFAULT_SUBJECT_UP = "[homepulse] Internet is back"
DEFAULT_BODY_DOWN = (
    "No speedtest record since ${DATETIME_DOWN}.\n\n"
    "Hi ${NAME}, you will receive another email once the internet comes back."
)
DEFAULT_BODY_UP = (
    "Hi ${NAME}, the internet is back!\n\n"
    "Down at: ${DATETIME_DOWN}\nRecovered at: ${DATETIME_UP}\nTotal downtime: ${TOTAL_TIME} min"
)

_gmail_service = None


@dataclass
class MonitorConfig:
    """Monitoring configuration loaded from Firestore.

    Attributes:
        max_minutes: Minutes without speedtest data before an outage is declared.
        recipients: List of dicts with 'email' and 'name' keys for alert recipients.
        subject_down: Email subject used when the internet goes down.
        subject_up: Email subject used when the internet recovers.
        body_down: Body template for the outage alert. Supports ${NAME} and ${DATETIME_DOWN}.
        body_up: Body template for the recovery alert. Supports ${NAME}, ${DATETIME_DOWN},
            ${DATETIME_UP}, and ${TOTAL_TIME}.
        notify_on_down: Whether to send email alerts when an outage is detected.
        notify_on_recovery: Whether to send email alerts when the internet recovers.
    """

    max_minutes: int
    recipients: list[dict]
    subject_down: str
    subject_up: str
    body_down: str
    body_up: str
    notify_on_down: bool
    notify_on_recovery: bool


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

        return MonitorConfig(
            max_minutes=max_minutes,
            recipients=recipients,
            subject_down=data.get("email_subject_down") or DEFAULT_SUBJECT_DOWN,
            subject_up=data.get("email_subject_up") or DEFAULT_SUBJECT_UP,
            body_down=data.get("email_body_down") or DEFAULT_BODY_DOWN,
            body_up=data.get("email_body_up") or DEFAULT_BODY_UP,
            notify_on_down=bool(data.get("notify_on_down", True)),
            notify_on_recovery=bool(data.get("notify_on_recovery", True)),
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


def _get_latest_speedtest_timestamp(db: firestore.Client) -> datetime | None:
    """Queries the most recent speedtest result from Firestore.

    Args:
        db: Authenticated Firestore client.

    Returns:
        The UTC timestamp of the latest document, or None if the collection is empty.
    """
    docs = (
        db.collection(COLLECTION_SPEEDTEST)
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


def _read_monitor_state(db: firestore.Client) -> bool:
    """Reads the current internet-down state from Firestore.

    Args:
        db: Authenticated Firestore client.

    Returns:
        True if the internet was previously flagged as down, False otherwise.
    """
    doc = db.collection(COLLECTION_STATE).document(STATE_DOC).get()
    if doc.exists:
        return bool(doc.to_dict().get("internet_down", False))
    return False


def _write_monitor_state(db: firestore.Client, internet_down: bool) -> None:
    """Persists the current internet-down state to Firestore.

    Args:
        db: Authenticated Firestore client.
        internet_down: True if the internet is currently considered down.
    """
    now = datetime.now(timezone.utc)
    field_name = "last_down_alert_at" if internet_down else "last_recovery_alert_at"
    db.collection(COLLECTION_STATE).document(STATE_DOC).set(
        {"internet_down": internet_down, field_name: now},
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
        last_timestamp: UTC timestamp of the last received speedtest record.
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


@functions_framework.http
def check_internet_status(request) -> tuple[str, int]:
    """Check whether recent speedtest data exists and send alert emails if needed.

    Reads the latest document from Firestore, compares its timestamp against
    the configured threshold, and sends a Gmail alert on state transitions
    (down→up or up→down). Incident documents are created and closed accordingly.
    Emails are sent to all configured recipients with per-recipient name substitution.

    Args:
        request: HTTP request object provided by Cloud Functions runtime.

    Returns:
        A tuple of (response_body, http_status_code).
    """
    try:
        db = _get_firestore_client()
        config = _load_monitor_config(db)

        last_timestamp = _get_latest_speedtest_timestamp(db)
        if last_timestamp is None:
            logger.warning("No speedtest documents found in Firestore — skipping check")
            return "No data available", 200

        now = datetime.now(timezone.utc)
        diff_minutes = (now - last_timestamp).total_seconds() / 60

        logger.info(
            "Last record: %s — %.1f min ago (threshold: %d min)",
            last_timestamp.strftime("%Y-%m-%d %H:%M:%S UTC"),
            diff_minutes,
            config.max_minutes,
        )

        internet_was_down = _read_monitor_state(db)

        if diff_minutes > config.max_minutes:
            if not internet_was_down:
                logger.info("Internet appears DOWN — creating incident and sending alerts")
                _create_incident(db)
                _write_monitor_state(db, internet_down=True)
                if config.notify_on_down:
                    for recipient in config.recipients:
                        _send_down_alert(
                            recipient=recipient,
                            last_timestamp=last_timestamp,
                            diff_minutes=diff_minutes,
                            subject=config.subject_down,
                            body_template=config.body_down,
                        )
            else:
                logger.info("Internet still DOWN — no duplicate alert sent")
        else:
            if internet_was_down:
                logger.info("Internet is BACK — closing incident and sending recovery alerts")
                started_at, duration_minutes = _close_latest_incident(db)
                _write_monitor_state(db, internet_down=False)
                if config.notify_on_recovery:
                    for recipient in config.recipients:
                        _send_recovery_alert(
                            recipient=recipient,
                            recovery_timestamp=last_timestamp,
                            started_at=started_at,
                            duration_minutes=duration_minutes,
                            subject=config.subject_up,
                            body_template=config.body_up,
                        )
            else:
                logger.info("Internet is UP — nothing to do")

        return "OK", 200

    except Exception as exc:
        logger.exception("Unexpected error during internet status check: %s", exc)
        return f"Internal error: {exc}", 500
