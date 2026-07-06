import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { take } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Timestamp } from '@angular/fire/firestore';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { SettingsDataService } from './settings-data.service';
import { MonitorConfig, Recipient } from '../../core/models/monitor-config.model';
import { environment } from '../../../environments/environment';

const SUBJECT_PREFIX = '[homepulse] ';
const DEFAULT_SUBJECT_DOWN_SUFFIX = 'Internet is down';
const DEFAULT_SUBJECT_UP_SUFFIX   = 'Internet is back';
const DEFAULT_BODY_DOWN =
  'No heartbeat received since ${DATETIME_DOWN}.\n\nHi ${NAME}, you will receive another email once the internet comes back.';
const DEFAULT_BODY_UP =
  'Hi ${NAME}, the internet is back!\n\nDown at: ${DATETIME_DOWN}\nRecovered at: ${DATETIME_UP}\nTotal downtime: ${TOTAL_TIME} min';

const FORM_DEFAULTS = {
  check_interval_minutes:   15,
  max_minutes_without_data: 45,
  email_subject_down:       DEFAULT_SUBJECT_DOWN_SUFFIX,
  email_subject_up:         DEFAULT_SUBJECT_UP_SUFFIX,
  email_body_down:          DEFAULT_BODY_DOWN,
  email_body_up:            DEFAULT_BODY_UP,
  notify_on_down:           true,
  notify_on_recovery:       true,
};

/**
 * Strips the mandatory "[homepulse] " prefix from a stored subject string.
 * Returns only the editable suffix so it can be bound to the form field.
 *
 * @param subject - Full subject string as stored in Firestore.
 */
function stripSubjectPrefix(subject: string): string {
  return subject.startsWith(SUBJECT_PREFIX) ? subject.slice(SUBJECT_PREFIX.length) : subject;
}

/**
 * Cross-field validator: max_minutes_without_data must be greater than check_interval_minutes.
 *
 * @param control - The form group to validate.
 * @returns Validation errors or null if valid.
 */
function thresholdValidator(control: AbstractControl): ValidationErrors | null {
  const interval  = control.get('check_interval_minutes')?.value as number | null;
  const threshold = control.get('max_minutes_without_data')?.value as number | null;
  if (interval !== null && threshold !== null && threshold <= interval) {
    return { thresholdTooLow: true };
  }
  return null;
}

/**
 * Formats a Firestore Timestamp to "dd/MM/yyyy HH:mm".
 *
 * @param ts - Timestamp to format.
 */
function formatTimestamp(ts: Timestamp): string {
  const d = ts.toDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Reconstructs a Recipient list from a stored config, applying lazy migration from
 * the legacy single `alert_email` field when `alert_emails` is absent.
 *
 * @param config - The config document loaded from Firestore.
 */
function buildRecipients(config: MonitorConfig): Recipient[] {
  const emails = config.alert_emails?.length
    ? config.alert_emails
    : config.alert_email ? [config.alert_email] : [environment.allowedEmail];
  const names = config.recipient_names ?? {};
  return emails.map(email => ({ email, name: names[email] ?? '' }));
}

/**
 * Settings screen.
 *
 * Manages monitoring intervals, alert thresholds, email recipients (with display names),
 * per-alert email subjects, and body templates with placeholder substitution support.
 * All values are persisted to `monitor_config/current` in Firestore.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NavbarComponent,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    TranslatePipe,
  ],
  template: `
    <app-navbar />

    <main class="settings-main">
      <h1 class="settings-title">{{ 'SETTINGS.TITLE' | translate }}</h1>

      <form [formGroup]="form" (ngSubmit)="save()">

        <!-- Status Check section -->
        <mat-card class="settings-card">
          <mat-card-header>
            <mat-card-title>{{ 'SETTINGS.SECTION_CHECK' | translate }}</mat-card-title>
          </mat-card-header>
          <mat-card-content>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ 'SETTINGS.FIELD_INTERVAL' | translate }}</mat-label>
              <input matInput type="number" formControlName="check_interval_minutes" />
              <mat-hint>{{ 'SETTINGS.FIELD_INTERVAL_HINT' | translate }}</mat-hint>
              @if (form.get('check_interval_minutes')?.invalid && form.get('check_interval_minutes')?.touched) {
                <mat-error>5 – 60</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ 'SETTINGS.FIELD_THRESHOLD' | translate }}</mat-label>
              <input matInput type="number" formControlName="max_minutes_without_data" />
              @if (form.hasError('thresholdTooLow') && form.get('max_minutes_without_data')?.dirty) {
                <mat-error>{{ 'SETTINGS.THRESHOLD_ERROR' | translate }}</mat-error>
              }
            </mat-form-field>

          </mat-card-content>
        </mat-card>

        <!-- Email Notifications section -->
        <mat-card class="settings-card">
          <mat-card-header>
            <mat-card-title>{{ 'SETTINGS.SECTION_EMAIL' | translate }}</mat-card-title>
          </mat-card-header>
          <mat-card-content>

            <p class="section-label">{{ 'SETTINGS.SECTION_RECIPIENTS' | translate }}</p>

            <div class="chip-list">
              @for (r of recipients(); track r.email; let i = $index) {
                <div class="recipient-chip">
                  <span class="chip-body" (click)="openEditRecipient(i)">
                    <span class="chip-email">{{ r.email }}</span>
                    <span class="chip-sep">|</span>
                    <span class="chip-name">{{ r.name }}</span>
                  </span>
                  <button
                    type="button"
                    class="chip-remove"
                    (click)="removeRecipient(i)"
                    [attr.aria-label]="'COMMON.REMOVE' | translate"
                  >×</button>
                </div>
              }
            </div>

            @if (showRecipientForm()) {
              <div class="recipient-form" [formGroup]="addForm">
                <div class="recipient-form-fields">
                  <mat-form-field appearance="outline" class="recipient-field">
                    <mat-label>{{ 'SETTINGS.FIELD_RECIPIENT_NAME' | translate }}</mat-label>
                    <input matInput type="text" formControlName="name" />
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="recipient-field">
                    <mat-label>{{ 'SETTINGS.FIELD_RECIPIENT_EMAIL' | translate }}</mat-label>
                    <input matInput type="email" formControlName="email" />
                    @if (addForm.get('email')?.invalid && addForm.get('email')?.touched) {
                      <mat-error>{{ 'SETTINGS.FIELD_EMAIL_INVALID' | translate }}</mat-error>
                    }
                  </mat-form-field>
                </div>
                <div class="recipient-form-actions">
                  <button type="button" mat-button (click)="cancelRecipientForm()">
                    {{ 'SETTINGS.CANCEL' | translate }}
                  </button>
                  <button
                    type="button"
                    mat-raised-button
                    color="primary"
                    (click)="confirmRecipient()"
                    [disabled]="addForm.invalid"
                  >
                    {{ 'SETTINGS.CONFIRM' | translate }}
                  </button>
                </div>
              </div>
            } @else {
              <button type="button" mat-stroked-button (click)="openAddRecipient()">
                + {{ 'SETTINGS.ADD_RECIPIENT' | translate }}
              </button>
            }

            <div class="checkbox-group">
              <mat-checkbox formControlName="notify_on_down">
                {{ 'SETTINGS.FIELD_NOTIFY_DOWN' | translate }}
              </mat-checkbox>
              <mat-checkbox formControlName="notify_on_recovery">
                {{ 'SETTINGS.FIELD_NOTIFY_RECOVERY' | translate }}
              </mat-checkbox>
            </div>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ 'SETTINGS.FIELD_SUBJECT_DOWN' | translate }}</mat-label>
              <span matTextPrefix class="subject-prefix">[homepulse]&nbsp;</span>
              <input matInput type="text" formControlName="email_subject_down" />
            </mat-form-field>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ 'SETTINGS.FIELD_SUBJECT_UP' | translate }}</mat-label>
              <span matTextPrefix class="subject-prefix">[homepulse]&nbsp;</span>
              <input matInput type="text" formControlName="email_subject_up" />
            </mat-form-field>

          </mat-card-content>
        </mat-card>

        <!-- Email Templates section -->
        <mat-card class="settings-card">
          <mat-card-header>
            <mat-card-title>{{ 'SETTINGS.SECTION_TEMPLATE' | translate }}</mat-card-title>
          </mat-card-header>
          <mat-card-content>

            <p class="placeholder-hint">{{ 'SETTINGS.PLACEHOLDERS_HINT_DOWN' | translate }}</p>
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ 'SETTINGS.FIELD_BODY_DOWN' | translate }}</mat-label>
              <textarea matInput formControlName="email_body_down" rows="5"></textarea>
            </mat-form-field>

            <p class="placeholder-hint">{{ 'SETTINGS.PLACEHOLDERS_HINT_UP' | translate }}</p>
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ 'SETTINGS.FIELD_BODY_UP' | translate }}</mat-label>
              <textarea matInput formControlName="email_body_up" rows="5"></textarea>
            </mat-form-field>

          </mat-card-content>
        </mat-card>

        <!-- Actions row -->
        <div class="actions">
          @if (lastUpdated()) {
            <span class="last-updated">
              {{ 'SETTINGS.LAST_UPDATED' | translate }}: {{ lastUpdated() }}
            </span>
          }
          <div class="action-buttons">
            <button
              mat-button
              type="button"
              (click)="cancel()"
              [disabled]="(form.pristine && !recipientsDirty()) || saving()"
            >
              {{ 'SETTINGS.CANCEL' | translate }}
            </button>
            <button
              mat-raised-button
              color="primary"
              type="submit"
              [disabled]="form.invalid || (form.pristine && !recipientsDirty()) || saving() || recipients().length === 0"
            >
              @if (saving()) {
                <mat-spinner diameter="20" />
              } @else {
                {{ 'SETTINGS.SAVE' | translate }}
              }
            </button>
          </div>
        </div>

      </form>
    </main>
  `,
  styles: [`
    .settings-main {
      max-width: 680px;
      margin: 0 auto;
      padding: 0 1.5rem 3rem;
    }

    .settings-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 1.5rem 0 1rem;
      color: var(--mat-sys-on-surface);
    }

    .settings-card {
      margin-bottom: 1.25rem;
    }

    mat-card-content {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding-top: 1rem !important;
    }

    .full-width {
      width: 100%;
    }

    .section-label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--mat-sys-on-surface-variant);
      margin: 0 0 0.25rem;
    }

    .placeholder-hint {
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
      font-family: monospace;
      margin: 0.25rem 0 0;
    }

    /* Recipient chips */
    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      min-height: 2rem;
    }

    .recipient-chip {
      display: flex;
      align-items: center;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 1rem;
      overflow: hidden;
      height: 2rem;
      font-size: 0.85rem;
      background: var(--mat-sys-surface-variant);
    }

    .chip-body {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0 0.5rem 0 0.75rem;
      cursor: pointer;
      height: 100%;
      user-select: none;
    }

    .chip-body:hover {
      background: var(--mat-sys-primary-container);
    }

    .chip-name {
      font-weight: 500;
      color: var(--mat-sys-on-surface);
    }

    .chip-sep {
      color: var(--mat-sys-outline);
    }

    .chip-email {
      color: var(--mat-sys-on-surface-variant);
    }

    .chip-remove {
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 0 0.5rem;
      height: 100%;
      color: var(--mat-sys-on-surface-variant);
      font-size: 1.1rem;
      line-height: 1;
    }

    .chip-remove:hover {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }

    /* Inline recipient form */
    .recipient-form {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 0.5rem;
      padding: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      background: var(--mat-sys-surface-container-low);
    }

    .recipient-form-fields {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .recipient-field {
      flex: 1;
      min-width: 200px;
    }

    .recipient-form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
    }

    .checkbox-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.25rem 0;
    }

    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
      padding-top: 0.5rem;
    }

    .last-updated {
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
    }

    .action-buttons {
      display: flex;
      gap: 0.75rem;
      margin-left: auto;
    }

    button[mat-raised-button] mat-spinner {
      display: inline-block;
    }

    .subject-prefix {
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.9rem;
      white-space: nowrap;
    }
  `],
})
export class SettingsComponent implements OnInit {
  private dataService = inject(SettingsDataService);
  private fb          = inject(FormBuilder);
  private snackBar    = inject(MatSnackBar);
  private translate   = inject(TranslateService);
  private destroyRef  = inject(DestroyRef);
  private cdr         = inject(ChangeDetectorRef);

  /** True while the Firestore save operation is in flight. */
  readonly saving = signal(false);

  /** Formatted "dd/MM/yyyy HH:mm" string of last successful save, or null. */
  readonly lastUpdated = signal<string | null>(null);

  /** Current list of email recipients managed outside the reactive form. */
  readonly recipients = signal<Recipient[]>([]);

  /** True when recipients have been modified since the last save or cancel. */
  readonly recipientsDirty = signal(false);

  /** Controls visibility of the inline add/edit recipient form. */
  readonly showRecipientForm = signal(false);

  /** Index of the recipient being edited, or null when adding a new one. */
  private editingIndex: number | null = null;

  private savedFormValues = { ...FORM_DEFAULTS };
  private savedRecipients: Recipient[] = [];

  readonly form = this.fb.group(
    {
      check_interval_minutes:   [FORM_DEFAULTS.check_interval_minutes,   [Validators.required, Validators.min(5), Validators.max(60)]],
      max_minutes_without_data: [FORM_DEFAULTS.max_minutes_without_data, [Validators.required, Validators.min(1)]],
      email_subject_down:       [FORM_DEFAULTS.email_subject_down,       Validators.required],
      email_subject_up:         [FORM_DEFAULTS.email_subject_up,         Validators.required],
      email_body_down:          [FORM_DEFAULTS.email_body_down,          Validators.required],
      email_body_up:            [FORM_DEFAULTS.email_body_up,            Validators.required],
      notify_on_down:           [FORM_DEFAULTS.notify_on_down],
      notify_on_recovery:       [FORM_DEFAULTS.notify_on_recovery],
    },
    { validators: thresholdValidator },
  );

  /** Separate form group for the inline add/edit recipient panel. */
  readonly addForm = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    name:  ['', Validators.required],
  });

  /**
   * Loads the current config from Firestore and patches the form and recipient list.
   * Applies lazy migration from the legacy `alert_email` field when `alert_emails` is absent.
   */
  ngOnInit(): void {
    this.dataService.getConfig().pipe(
      take(1),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(config => {
      const recipientList = config
        ? buildRecipients(config)
        : [{ email: environment.allowedEmail, name: '' }];

      this.recipients.set(recipientList);
      this.savedRecipients = [...recipientList];

      this.savedFormValues = {
        check_interval_minutes:   config?.check_interval_minutes   ?? FORM_DEFAULTS.check_interval_minutes,
        max_minutes_without_data: config?.max_minutes_without_data ?? FORM_DEFAULTS.max_minutes_without_data,
        email_subject_down:       stripSubjectPrefix(config?.email_subject_down ?? (SUBJECT_PREFIX + FORM_DEFAULTS.email_subject_down)),
        email_subject_up:         stripSubjectPrefix(config?.email_subject_up   ?? (SUBJECT_PREFIX + FORM_DEFAULTS.email_subject_up)),
        email_body_down:          config?.email_body_down          ?? FORM_DEFAULTS.email_body_down,
        email_body_up:            config?.email_body_up            ?? FORM_DEFAULTS.email_body_up,
        notify_on_down:           config?.notify_on_down           ?? FORM_DEFAULTS.notify_on_down,
        notify_on_recovery:       config?.notify_on_recovery       ?? FORM_DEFAULTS.notify_on_recovery,
      };

      this.form.patchValue(this.savedFormValues);
      this.form.markAsPristine();
      this.recipientsDirty.set(false);

      if (config?.updated_at) {
        this.lastUpdated.set(formatTimestamp(config.updated_at));
      }
      this.cdr.markForCheck();
    });
  }

  /**
   * Persists the current form values and recipient list to Firestore.
   * Serialises the recipient signal into `alert_emails` and `recipient_names`.
   */
  async save(): Promise<void> {
    if (this.form.invalid || this.saving()) return;

    this.saving.set(true);
    this.form.disable();

    try {
      const raw = this.form.getRawValue();
      const recipientList = this.recipients();

      const values: Omit<MonitorConfig, 'updated_at' | 'alert_email'> = {
        check_interval_minutes:   Number(raw.check_interval_minutes),
        max_minutes_without_data: Number(raw.max_minutes_without_data),
        alert_emails:             recipientList.map(r => r.email),
        recipient_names:          Object.fromEntries(recipientList.map(r => [r.email, r.name])),
        email_subject_down:       SUBJECT_PREFIX + (raw.email_subject_down ?? FORM_DEFAULTS.email_subject_down),
        email_subject_up:         SUBJECT_PREFIX + (raw.email_subject_up   ?? FORM_DEFAULTS.email_subject_up),
        email_body_down:          raw.email_body_down    ?? DEFAULT_BODY_DOWN,
        email_body_up:            raw.email_body_up      ?? DEFAULT_BODY_UP,
        notify_on_down:           raw.notify_on_down     ?? true,
        notify_on_recovery:       raw.notify_on_recovery ?? true,
      };

      await this.dataService.saveConfig(values);

      this.savedFormValues = {
        check_interval_minutes:   values.check_interval_minutes,
        max_minutes_without_data: values.max_minutes_without_data,
        email_subject_down:       stripSubjectPrefix(values.email_subject_down),
        email_subject_up:         stripSubjectPrefix(values.email_subject_up),
        email_body_down:          values.email_body_down,
        email_body_up:            values.email_body_up,
        notify_on_down:           values.notify_on_down,
        notify_on_recovery:       values.notify_on_recovery,
      };
      this.savedRecipients = [...recipientList];
      this.lastUpdated.set(formatTimestamp(Timestamp.fromDate(new Date())));
      this.form.markAsPristine();
      this.recipientsDirty.set(false);
      this.snackBar.open(this.translate.instant('SETTINGS.SAVE_SUCCESS'), '', { duration: 3000 });
    } catch {
      this.snackBar.open(this.translate.instant('SETTINGS.SAVE_ERROR'), '', { duration: 4000 });
    } finally {
      this.saving.set(false);
      this.form.enable();
      this.cdr.markForCheck();
    }
  }

  /**
   * Restores the form and recipient list to the last successfully saved state.
   */
  cancel(): void {
    this.form.patchValue(this.savedFormValues);
    this.form.markAsPristine();
    this.recipients.set([...this.savedRecipients]);
    this.recipientsDirty.set(false);
    this.showRecipientForm.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Opens the inline recipient form in "add" mode with empty fields.
   */
  openAddRecipient(): void {
    this.editingIndex = null;
    this.addForm.reset({ email: '', name: '' });
    this.showRecipientForm.set(true);
  }

  /**
   * Opens the inline recipient form pre-filled with the selected recipient's data.
   *
   * @param index - Index of the recipient to edit in the recipients signal.
   */
  openEditRecipient(index: number): void {
    const r = this.recipients()[index];
    this.editingIndex = index;
    this.addForm.patchValue({ email: r.email, name: r.name });
    this.showRecipientForm.set(true);
  }

  /**
   * Confirms the add/edit form and updates the recipients signal.
   * Replaces the existing entry when editing, appends when adding.
   */
  confirmRecipient(): void {
    if (this.addForm.invalid) return;
    const { email, name } = this.addForm.getRawValue();
    const current = [...this.recipients()];
    if (this.editingIndex !== null) {
      current[this.editingIndex] = { email: email!, name: name! };
    } else {
      current.push({ email: email!, name: name! });
    }
    this.recipients.set(current);
    this.recipientsDirty.set(true);
    this.showRecipientForm.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Closes the inline recipient form without saving changes.
   */
  cancelRecipientForm(): void {
    this.showRecipientForm.set(false);
  }

  /**
   * Removes a recipient from the list by index.
   *
   * @param index - Index of the recipient to remove.
   */
  removeRecipient(index: number): void {
    this.recipients.set(this.recipients().filter((_, i) => i !== index));
    this.recipientsDirty.set(true);
    this.cdr.markForCheck();
  }
}
