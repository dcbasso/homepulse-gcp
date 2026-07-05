import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OutputEmitterRef,
  input,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatNativeDateModule } from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';

/** Preset time window options for the period selector. */
export type Period = '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '30d' | 'custom';

/** A resolved start/end date pair used to query Firestore. */
export interface DateRange {
  start: Date;
  end: Date;
}

/** Computes the concrete start/end dates for a preset period relative to now. */
function rangeFromPeriod(period: Exclude<Period, 'custom'>): DateRange {
  const end = new Date();
  const start = new Date();
  switch (period) {
    case '1h':  start.setHours(start.getHours() - 1);    break;
    case '3h':  start.setHours(start.getHours() - 3);    break;
    case '6h':  start.setHours(start.getHours() - 6);    break;
    case '12h': start.setHours(start.getHours() - 12);   break;
    case '24h': start.setDate(start.getDate() - 1);       break;
    case '7d':  start.setDate(start.getDate() - 7);       break;
    case '30d': start.setDate(start.getDate() - 30);      break;
  }
  return { start, end };
}

/**
 * Date range filter bar with preset options and a custom datepicker pair.
 *
 * Emits `filterChange` immediately when a preset is selected, or when
 * the user clicks Apply for a custom range.
 */
@Component({
  selector: 'app-date-range-filter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatDatepickerModule,
    MatNativeDateModule,
    MatInputModule,
    MatButtonModule,
    TranslatePipe,
  ],
  template: `
    <div class="filter-bar">
      <mat-form-field appearance="outline" class="period-select">
        <mat-label>{{ 'DASHBOARD.PERIOD_LABEL' | translate }}</mat-label>
        <mat-select [(ngModel)]="selectedPeriod" (ngModelChange)="onPeriodChange($event)">
          <mat-option value="1h">{{ 'DASHBOARD.PERIOD_1H' | translate }}</mat-option>
          <mat-option value="3h">{{ 'DASHBOARD.PERIOD_3H' | translate }}</mat-option>
          <mat-option value="6h">{{ 'DASHBOARD.PERIOD_6H' | translate }}</mat-option>
          <mat-option value="12h">{{ 'DASHBOARD.PERIOD_12H' | translate }}</mat-option>
          <mat-option value="24h">{{ 'DASHBOARD.PERIOD_24H' | translate }}</mat-option>
          <mat-option value="7d">{{ 'DASHBOARD.PERIOD_7D' | translate }}</mat-option>
          <mat-option value="30d">{{ 'DASHBOARD.PERIOD_30D' | translate }}</mat-option>
          <mat-option value="custom">{{ 'DASHBOARD.CUSTOM' | translate }}</mat-option>
        </mat-select>
      </mat-form-field>

      @if (selectedPeriod === 'custom') {
        <mat-form-field appearance="outline">
          <mat-label>{{ 'DASHBOARD.FROM' | translate }}</mat-label>
          <input matInput [matDatepicker]="pickerFrom" [(ngModel)]="customStart" />
          <mat-datepicker-toggle matIconSuffix [for]="pickerFrom" />
          <mat-datepicker #pickerFrom />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>{{ 'DASHBOARD.TO' | translate }}</mat-label>
          <input matInput [matDatepicker]="pickerTo" [(ngModel)]="customEnd" />
          <mat-datepicker-toggle matIconSuffix [for]="pickerTo" />
          <mat-datepicker #pickerTo />
        </mat-form-field>

        <button mat-raised-button color="primary" (click)="applyCustom()">
          {{ 'DASHBOARD.APPLY' | translate }}
        </button>
      }
    </div>
  `,
  styles: [`
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      padding: 1rem 0 0.25rem;
    }
    .period-select { width: 180px; }
    mat-form-field { margin-bottom: -1.25em; }
  `],
})
export class DateRangeFilterComponent implements OnInit {
  /** Emitted when the active date range changes (preset or custom apply). */
  readonly filterChange: OutputEmitterRef<DateRange> = output<DateRange>();

  /** Initial period to select and emit on init. Defaults to 24h. */
  readonly defaultPeriod = input<Exclude<Period, 'custom'>>('24h');

  selectedPeriod: Period = this.defaultPeriod();
  customStart: Date | null = null;
  customEnd: Date | null = null;

  /**
   * Emits the default range on init so the parent triggers its first
   * data load without waiting for user interaction.
   */
  ngOnInit(): void {
    this.selectedPeriod = this.defaultPeriod();
    this.filterChange.emit(rangeFromPeriod(this.defaultPeriod()));
  }

  /**
   * Handles preset selection. Emits the resolved range immediately,
   * unless the user switched to "custom" (which requires explicit Apply).
   *
   * @param period - The newly selected period option.
   */
  onPeriodChange(period: Period): void {
    if (period !== 'custom') {
      this.filterChange.emit(rangeFromPeriod(period as Exclude<Period, 'custom'>));
    }
  }

  /**
   * Validates and emits the user-defined custom range.
   * No-ops if either date input is empty.
   */
  applyCustom(): void {
    if (this.customStart && this.customEnd) {
      this.filterChange.emit({ start: this.customStart, end: this.customEnd });
    }
  }
}
