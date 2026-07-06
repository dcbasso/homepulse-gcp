import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCardModule } from '@angular/material/card';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, catchError, of, switchMap, tap } from 'rxjs';
import { Heartbeat } from '../../core/models/heartbeat.model';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { DateRange, DateRangeFilterComponent } from '../dashboard/components/date-range-filter/date-range-filter.component';
import { HeartbeatTableComponent } from './components/heartbeat-table/heartbeat-table.component';
import { HeartbeatHistoryDataService } from './heartbeat-history-data.service';

/** Default range for the heartbeat history filter (last 24 hours). */
function defaultRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 1);
  return { start, end };
}

/**
 * Heartbeat History screen.
 *
 * Displays a filterable, paginated table of heartbeat documents showing
 * the external IP captured at each liveness check.
 */
@Component({
  selector: 'app-heartbeat-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NavbarComponent,
    DateRangeFilterComponent,
    HeartbeatTableComponent,
    MatProgressSpinnerModule,
    MatCardModule,
    TranslatePipe,
  ],
  template: `
    <app-navbar />

    <main class="heartbeat-history-main">
      <h2 class="page-title">{{ 'HEARTBEAT_HISTORY.TITLE' | translate }}</h2>

      <app-date-range-filter
        defaultPeriod="24h"
        (filterChange)="onFilterChange($event)"
      />

      @if (!loading()) {
        <div class="summary-row">
          <mat-card appearance="outlined" class="summary-card">
            <mat-card-content>
              <span class="summary-label">{{ 'HEARTBEAT_HISTORY.UNIQUE_IPS' | translate }}</span>
              <span class="summary-value">{{ uniqueIpCount() }}</span>
            </mat-card-content>
          </mat-card>
        </div>
      }

      @if (loading()) {
        <div class="loading-row">
          <mat-spinner diameter="40" />
        </div>
      } @else {
        <app-heartbeat-table [results]="results()" />
      }
    </main>
  `,
  styles: [`
    .heartbeat-history-main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 1.5rem 3rem;
    }

    .page-title {
      margin: 1.5rem 0 0;
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
    }

    .loading-row {
      display: flex;
      justify-content: center;
      padding: 3rem 0;
    }

    .summary-row {
      display: flex;
      gap: 1rem;
      margin: 1rem 0;
    }

    .summary-card {
      min-width: 160px;
    }

    mat-card-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.75rem 1.25rem !important;
      gap: 0.25rem;
    }

    .summary-label {
      font-size: 0.75rem;
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .summary-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--mat-sys-primary);
    }
  `],
})
export class HeartbeatHistoryComponent implements OnInit {
  private dataService = inject(HeartbeatHistoryDataService);
  private snackBar    = inject(MatSnackBar);
  private translate   = inject(TranslateService);
  private destroyRef  = inject(DestroyRef);

  /** True while a Firestore query is in flight. */
  readonly loading = signal(true);

  /** Current result list for the active date range. */
  readonly results = signal<Heartbeat[]>([]);

  /** Number of distinct external IPs in the current result set. */
  readonly uniqueIpCount = computed(() =>
    new Set(this.results().map(r => r.external_ip).filter(Boolean)).size,
  );

  private filterRange$ = new BehaviorSubject<DateRange>(defaultRange());

  /**
   * Subscribes to filter range changes and fetches matching results from Firestore.
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
            return of([] as Heartbeat[]);
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
