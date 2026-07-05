import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, catchError, of, switchMap, tap } from 'rxjs';
import { SpeedtestResult } from '../../core/models/speedtest-result.model';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { DateRange, DateRangeFilterComponent } from '../dashboard/components/date-range-filter/date-range-filter.component';
import { HistoryTableComponent } from './components/history-table/history-table.component';
import { HistoryDataService } from './history-data.service';

/** Default range to seed the filter subject (24 hours back). */
function defaultRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 1);
  return { start, end };
}

/**
 * History screen.
 *
 * Displays a filterable, paginated table of all speedtest measurements
 * from Firestore, ordered by most recent first.
 */
@Component({
  selector: 'app-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NavbarComponent,
    DateRangeFilterComponent,
    HistoryTableComponent,
    MatCardModule,
    MatProgressSpinnerModule,
    TranslatePipe,
  ],
  template: `
    <app-navbar />

    <main class="history-main">
      <app-date-range-filter
        defaultPeriod="24h"
        (filterChange)="onFilterChange($event)"
      />

      <div class="summary-cards">
        <mat-card class="summary-card">
          <mat-card-content>
            <span class="card-label">{{ 'HISTORY.TOTAL_RECORDS' | translate }}</span>
            @if (loading()) {
              <mat-spinner diameter="24" />
            } @else {
              <span class="card-value">{{ results().length }}</span>
            }
          </mat-card-content>
        </mat-card>
      </div>

      @if (loading()) {
        <div class="loading-row">
          <mat-spinner diameter="40" />
        </div>
      } @else {
        <app-history-table [results]="results()" />
      }
    </main>
  `,
  styles: [`
    .history-main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 1.5rem 3rem;
    }

    .summary-cards {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin: 1.5rem 0;
    }

    .summary-card {
      min-width: 180px;
    }

    mat-card-content {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding-top: 0.75rem !important;
    }

    .card-label {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--mat-sys-on-surface-variant);
    }

    .card-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--mat-sys-on-surface);
    }

    .loading-row {
      display: flex;
      justify-content: center;
      padding: 3rem 0;
    }
  `],
})
export class HistoryComponent implements OnInit {
  private dataService = inject(HistoryDataService);
  private snackBar    = inject(MatSnackBar);
  private translate   = inject(TranslateService);
  private destroyRef  = inject(DestroyRef);

  /** True while a Firestore query is in flight. */
  readonly loading = signal(true);

  /** Current speedtest result list for the active date range. */
  readonly results = signal<SpeedtestResult[]>([]);

  private filterRange$ = new BehaviorSubject<DateRange>(defaultRange());

  /**
   * Subscribes to filter range changes and fetches matching records from Firestore.
   * On query failure, shows a snackbar and falls back to an empty list.
   */
  ngOnInit(): void {
    this.filterRange$.pipe(
      tap(() => this.loading.set(true)),
      switchMap(range =>
        this.dataService.getResults(range.start, range.end).pipe(
          catchError(() => {
            const msg = this.translate.instant('COMMON.ERROR');
            this.snackBar.open(msg, '', { duration: 4000 });
            return of([] as SpeedtestResult[]);
          }),
        ),
      ),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(results => {
      this.results.set(results);
      this.loading.set(false);
    });
  }

  /**
   * Handles date range changes emitted by the filter component.
   *
   * @param range - The new start/end date range to query.
   */
  onFilterChange(range: DateRange): void {
    this.filterRange$.next(range);
  }
}
