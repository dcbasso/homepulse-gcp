import { Timestamp } from '@angular/fire/firestore';

/** A single email recipient with a display name. */
export interface Recipient {
  email: string;
  name: string;
}

/** Firestore document schema for `monitor_config/current`. */
export interface MonitorConfig {
  check_interval_minutes: number;
  max_minutes_without_data: number;
  /** @deprecated Use alert_emails instead. Kept for lazy migration on load. */
  alert_email?: string;
  alert_emails: string[];
  recipient_names: Record<string, string>;
  email_subject_down: string;
  email_subject_up: string;
  email_body_down: string;
  email_body_up: string;
  notify_on_down: boolean;
  notify_on_recovery: boolean;
  updated_at?: Timestamp;
}
