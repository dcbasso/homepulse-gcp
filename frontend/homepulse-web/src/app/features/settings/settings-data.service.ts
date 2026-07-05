import { Injectable, inject } from '@angular/core';
import { serverTimestamp } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { FirestoreService } from '../../core/firestore.service';
import { MonitorConfig } from '../../core/models/monitor-config.model';

const CONFIG_PATH = 'monitor_config/current';

@Injectable({ providedIn: 'root' })
export class SettingsDataService {
  private firestoreService = inject(FirestoreService);

  /**
   * Returns a real-time observable of the current monitor configuration.
   * Emits `undefined` when the document does not exist in Firestore.
   */
  getConfig(): Observable<MonitorConfig | undefined> {
    return this.firestoreService.getDoc<MonitorConfig>(CONFIG_PATH);
  }

  /**
   * Persists the monitor configuration to Firestore with a server-side timestamp.
   *
   * @param config - Configuration values to write (updated_at is appended automatically).
   * @returns Promise that resolves when the write is committed.
   */
  saveConfig(config: Omit<MonitorConfig, 'updated_at'>): Promise<void> {
    return this.firestoreService.setDoc(CONFIG_PATH, {
      ...config,
      updated_at: serverTimestamp(),
    });
  }
}
