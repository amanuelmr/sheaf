import type { SyncPolicy } from '@sheaf/core';
import type { SqlDriver } from '@sheaf/store';

export interface AppSettings extends SyncPolicy {
  /**
   * Assumed scan resolution, used to size the page in the PDF.
   *
   * Identity-affecting (ADR 0002): the same pages at a different setting hash
   * differently, so changing it means a re-scan is a new document rather than a
   * recognised duplicate. That is why it is one number rather than a slider.
   */
  readonly dpi: number;
  readonly autoSync: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  wifiOnly: false,
  // Conservative by default: never delete the only copy without being asked.
  keepLocalAfterSync: true,
  dpi: 150,
  autoSync: true,
};

/**
 * Settings live in the database, not in the keystore: none of them are secret, and
 * they should be readable without unlocking anything.
 */
export async function loadSettings(driver: SqlDriver): Promise<AppSettings> {
  const rows = await driver.all<{ key: string; value: string }>(
    'SELECT key, value FROM app_settings',
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const bool = (key: string, fallback: boolean): boolean => {
    const value = stored.get(key);
    return value === undefined ? fallback : value === 'true';
  };
  const int = (key: string, fallback: number): number => {
    const value = Number(stored.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    wifiOnly: bool('wifiOnly', DEFAULT_SETTINGS.wifiOnly),
    keepLocalAfterSync: bool('keepLocalAfterSync', DEFAULT_SETTINGS.keepLocalAfterSync),
    autoSync: bool('autoSync', DEFAULT_SETTINGS.autoSync),
    dpi: int('dpi', DEFAULT_SETTINGS.dpi),
  };
}

export async function saveSetting(
  driver: SqlDriver,
  key: keyof AppSettings,
  value: string | number | boolean,
): Promise<void> {
  await driver.run(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)],
  );
}
