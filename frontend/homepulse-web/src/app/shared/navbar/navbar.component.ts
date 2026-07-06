import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/** Languages available in the UI, in the order the toggle cycles through them. */
const SUPPORTED_LANGS = ['pt-BR', 'en', 'es'] as const;

/**
 * Top navigation bar shown on all authenticated screens.
 *
 * Provides navigation links, language toggle, theme toggle, and sign-out.
 */
@Component({
  selector: 'app-navbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatToolbarModule, MatButtonModule, MatIconModule, RouterLink, RouterLinkActive, TranslatePipe],
  template: `
    <mat-toolbar class="navbar">
      <span class="app-title">{{ 'LOGIN.TITLE' | translate }}</span>
      <nav class="nav-links">
        <a mat-button routerLink="/dashboard" routerLinkActive="active-link">
          {{ 'NAV.DASHBOARD' | translate }}
        </a>
        <a mat-button routerLink="/incidents" routerLinkActive="active-link">
          {{ 'NAV.INCIDENTS' | translate }}
        </a>
        <a mat-button routerLink="/ip-history" routerLinkActive="active-link">
          {{ 'NAV.IP_HISTORY' | translate }}
        </a>
        <a mat-button routerLink="/history" routerLinkActive="active-link">
          {{ 'NAV.HISTORY' | translate }}
        </a>
        <a mat-button routerLink="/settings" routerLinkActive="active-link">
          {{ 'NAV.SETTINGS' | translate }}
        </a>
        <a mat-button routerLink="/about" routerLinkActive="active-link">
          {{ 'NAV.ABOUT' | translate }}
        </a>
      </nav>
      <span class="spacer"></span>
      <button mat-icon-button (click)="toggleLang()" [attr.aria-label]="currentLang()">
        <mat-icon>language</mat-icon>
      </button>
      <button mat-icon-button (click)="themeService.toggleTheme()" aria-label="Toggle theme">
        <mat-icon>{{ isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
      </button>
      <button mat-button (click)="signOut()">
        {{ 'NAV.SIGN_OUT' | translate }}
      </button>
    </mat-toolbar>
  `,
  styles: [`
    .navbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background-color: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      box-shadow: none;
    }
    .app-title {
      font-weight: 700;
      font-size: 1rem;
      margin-right: 1.5rem;
      color: var(--mat-sys-primary);
    }
    .nav-links { display: flex; gap: 0.25rem; }
    .spacer { flex: 1; }
    .active-link { font-weight: 700; }
  `],
})
export class NavbarComponent {
  protected themeService = inject(ThemeService);
  private authService = inject(AuthService);
  private translate = inject(TranslateService);

  /** Reactive dark-mode flag derived from ThemeService. */
  protected isDark = toSignal(this.themeService.isDark$, { initialValue: false });

  /** Current active language code, updated reactively on each language switch. */
  protected currentLang = toSignal(
    this.translate.onLangChange.pipe(map(e => e.lang)),
    { initialValue: 'pt-BR' },
  );

  /**
   * Cycles the UI language through the supported locales and persists the choice.
   */
  toggleLang(): void {
    const currentIndex = SUPPORTED_LANGS.indexOf(this.currentLang() as (typeof SUPPORTED_LANGS)[number]);
    const next = SUPPORTED_LANGS[(currentIndex + 1) % SUPPORTED_LANGS.length];
    this.translate.use(next);
    localStorage.setItem('lang', next);
  }

  /**
   * Signs out the current user and navigates to the login screen.
   */
  signOut(): void {
    this.authService.signOut().subscribe();
  }
}
