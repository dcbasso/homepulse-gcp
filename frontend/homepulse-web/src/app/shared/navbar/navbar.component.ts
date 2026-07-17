import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/** A UI language option: the ngx-translate locale code paired with its display badge. */
interface LangOption {
  code: 'pt-BR' | 'en' | 'es';
  badge: string;
}

/** Languages available in the UI, in the order they appear in the selector menu. */
const SUPPORTED_LANGS: readonly LangOption[] = [
  { code: 'pt-BR', badge: 'PT-BR' },
  { code: 'en', badge: 'ENG' },
  { code: 'es', badge: 'ESP' },
];

/**
 * Top navigation bar shown on all authenticated screens.
 *
 * Provides navigation links, language toggle, theme toggle, and sign-out.
 */
@Component({
  selector: 'app-navbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    RouterLink,
    RouterLinkActive,
    TranslatePipe,
  ],
  template: `
    <mat-toolbar class="navbar">
      <img class="app-logo" src="assets/images/logo/logo-icon.png" alt="" />
      <span class="app-title">{{ 'LOGIN.TITLE' | translate }}</span>
      <nav class="nav-links">
        <a mat-button routerLink="/dashboard" routerLinkActive="active-link">
          {{ 'NAV.DASHBOARD' | translate }}
        </a>
        <a mat-button routerLink="/incidents" routerLinkActive="active-link">
          {{ 'NAV.INCIDENTS' | translate }}
        </a>
        <a mat-button routerLink="/heartbeat-history" routerLinkActive="active-link">
          {{ 'NAV.HEARTBEAT_HISTORY' | translate }}
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
      <button
        mat-stroked-button
        class="lang-selector"
        [matMenuTriggerFor]="langMenu"
        [attr.aria-label]="'NAV.LANGUAGE' | translate"
      >
        <mat-icon>language</mat-icon>
        <span>{{ currentLangBadge() }}</span>
      </button>
      <mat-menu #langMenu="matMenu">
        @for (lang of langOptions; track lang.code) {
          <button mat-menu-item (click)="setLang(lang.code)" [class.active-lang]="lang.code === currentLang()">
            @if (lang.code === currentLang()) {
              <mat-icon>check</mat-icon>
            }
            <span>{{ lang.badge }}</span>
          </button>
        }
      </mat-menu>
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
    .app-logo {
      height: 28px;
      width: 28px;
      margin-right: 0.5rem;
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
    .lang-selector {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      border-radius: 999px;
      margin-right: 0.5rem;
    }
    .active-lang { font-weight: 700; }
  `],
})
export class NavbarComponent {
  protected themeService = inject(ThemeService);
  private authService = inject(AuthService);
  private translate = inject(TranslateService);

  /** Language options shown in the selector menu. */
  protected langOptions = SUPPORTED_LANGS;

  /** Reactive dark-mode flag derived from ThemeService. */
  protected isDark = toSignal(this.themeService.isDark$, { initialValue: false });

  /** Current active language code, updated reactively on each language switch. */
  protected currentLang = toSignal(
    this.translate.onLangChange.pipe(map(e => e.lang)),
    { initialValue: 'pt-BR' },
  );

  /** Display badge (e.g. "PT-BR") for the currently active language. */
  protected currentLangBadge(): string {
    return SUPPORTED_LANGS.find(lang => lang.code === this.currentLang())?.badge ?? '';
  }

  /**
   * Switches the UI to the given language and persists the choice.
   */
  setLang(code: LangOption['code']): void {
    this.translate.use(code);
    localStorage.setItem('lang', code);
  }

  /**
   * Signs out the current user and navigates to the login screen.
   */
  signOut(): void {
    this.authService.signOut().subscribe();
  }
}
