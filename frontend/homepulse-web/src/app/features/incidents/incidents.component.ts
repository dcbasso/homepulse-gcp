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
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, catchError, of, switchMap, tap } from 'rxjs';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { DateRange, DateRangeFilterComponent } from '../dashboard/components/date-range-filter/date-range-filter.component';
import { IncidentListComponent } from './components/incident-list/incident-list.component';
import { IncidentPatternComponent } from './components/incident-pattern/incident-pattern.component';
import { IncidentsDataService } from './incidents-data.service';
import { IncidentPatternService } from './incident-pattern.service';
import { Incident } from '../../core/models/incident.model';

/** Formats a total number of minutes as "Xh YYmin", or "—" for zero/null. */
function formatTotalOffline(totalMinutes: number): string {
  if (totalMinutes === 0) return '—';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${m}min`;
}

/** Default range to seed the filter subject (30 days back). */
function defaultRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start, end };
}

/**
 * Incidents screen.
 *
 * Displays a filterable list of internet outage incidents from Firestore,
 * along with summary cards showing total incident count and total offline time.
 */
@Component({
  selector: 'app-incidents',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NavbarComponent,
    DateRangeFilterComponent,
    IncidentListComponent,
    IncidentPatternComponent,
    MatCardModule,
    MatProgressSpinnerModule,
    TranslatePipe,
  ],
  template: `
    <app-navbar />

    <main class="incidents-main">
      <app-date-range-filter
        defaultPeriod="30d"
        (filterChange)="onFilterChange($event)"
      />

      <div class="summary-cards">
        <mat-card class="summary-card">
          <mat-card-content>
            <span class="card-label">{{ 'INCIDENTS.TOTAL' | translate }}</span>
            @if (loading()) {
              <mat-spinner diameter="24" />
            } @else {
              <span class="card-value">{{ incidents().length }}</span>
            }
          </mat-card-content>
        </mat-card>

        <mat-card class="summary-card">
          <mat-card-content>
            <span class="card-label">{{ 'INCIDENTS.TOTAL_OFFLINE' | translate }}</span>
            @if (loading()) {
              <mat-spinner diameter="24" />
            } @else {
              <span class="card-value">{{ totalOffline() }}</span>
            }
          </mat-card-content>
        </mat-card>
      </div>

      @if (loading()) {
        <div class="loading-row">
          <mat-spinner diameter="40" />
        </div>
      } @else {
        <app-incident-pattern [pattern]="pattern()" />
        <app-incident-list [incidents]="incidents()" />
      }
    </main>
  `,
  styles: [`
    .incidents-main {
      max-width: 1100px;
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
      flex: 1;
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
export class IncidentsComponent implements OnInit {
  private dataService    = inject(IncidentsDataService);
  private patternService = inject(IncidentPatternService);
  private snackBar       = inject(MatSnackBar);
  private translate      = inject(TranslateService);
  private destroyRef     = inject(DestroyRef);

  /** True while a Firestore query is in flight. */
  readonly loading = signal(true);

  /** Current incident list for the active date range. */
  readonly incidents = signal<Incident[]>([]);

  /** Pattern report derived from the current incident list. */
  readonly pattern = computed(() => this.patternService.compute(this.incidents()));

  /**
   * Sum of duration_minutes for all recovered incidents.
   * Formatted as "Xh YYmin", or "—" when none have recovered yet.
   */
  readonly totalOffline = computed<string>(() => {
    const total = this.incidents()
      .filter(i => i.duration_minutes !== null)
      .reduce((sum, i) => sum + (i.duration_minutes ?? 0), 0);
    return formatTotalOffline(total);
  });

  private filterRange$ = new BehaviorSubject<DateRange>(defaultRange());

  /**
   * Subscribes to filter range changes and fetches matching incidents from Firestore.
   * On query failure, shows a snackbar and falls back to an empty list.
   */
  ngOnInit(): void {
    this.filterRange$.pipe(
      tap(() => this.loading.set(true)),
      switchMap(range =>
        this.dataService.getIncidents(range.start, range.end).pipe(
          catchError(() => {
            const msg = this.translate.instant('COMMON.ERROR');
            this.snackBar.open(msg, '', { duration: 4000 });
            return of([] as Incident[]);
          }),
        ),
      ),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(incidents => {
      this.incidents.set(incidents);
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
