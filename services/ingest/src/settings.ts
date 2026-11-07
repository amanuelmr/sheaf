import {
  SETTING_KEYS,
  type ServerSettings,
  type SettingSource,
  type SettingsPatch,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';

/** What the server uses when neither the environment nor an admin says otherwise. */
export const BUILT_IN: ServerSettings = {
  trashDays: 30,
  filenameFormat: '{{created_year}}/{{correspondent}}/{{title}}',
  barcodesEnabled: false,
  barcodeSeparator: 'PATCHT',
  barcodeAsnPrefix: 'ASN',
};

/**
 * Settings an admin can change while the server runs.
 *
 * Each comes from, in order: what an admin saved, the environment the server was
 * started with, the built-in default. Kept in memory as well as in the database,
 * so the parts of the server that read them on every pass do not query for them.
 */
export class Settings {
  readonly #driver: SqlDriver;
  readonly #environment: Partial<ServerSettings>;
  #saved: Partial<Record<keyof ServerSettings, unknown>> = {};

  private constructor(driver: SqlDriver, environment: Partial<ServerSettings>) {
    this.#driver = driver;
    this.#environment = environment;
  }

  static async open(driver: SqlDriver, environment: Partial<ServerSettings>): Promise<Settings> {
    const settings = new Settings(driver, environment);
    const rows = await driver.all<{ key: string; value_json: string }>(
      'SELECT key, value_json FROM settings',
    );
    for (const row of rows) {
      if ((SETTING_KEYS as readonly string[]).includes(row.key)) {
        settings.#saved[row.key as keyof ServerSettings] = JSON.parse(row.value_json) as unknown;
      }
    }
    return settings;
  }

  current(): ServerSettings {
    return { ...BUILT_IN, ...this.#environment, ...this.#saved } as ServerSettings;
  }

  sources(): Record<keyof ServerSettings, SettingSource> {
    return Object.fromEntries(
      SETTING_KEYS.map((key) => [
        key,
        key in this.#saved
          ? 'saved'
          : this.#environment[key] !== undefined
            ? 'environment'
            : 'default',
      ]),
    ) as Record<keyof ServerSettings, SettingSource>;
  }

  /** Save the values given; `null` forgets a saved one. Checked by the caller. */
  async update(patch: SettingsPatch, now: number): Promise<ServerSettings> {
    await this.#driver.transaction(async () => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          await this.#driver.run('DELETE FROM settings WHERE key = ?', [key]);
        } else {
          await this.#driver.run(
            `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
            [key, JSON.stringify(value), now],
          );
        }
      }
    });
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete this.#saved[key as keyof ServerSettings];
      else this.#saved[key as keyof ServerSettings] = value;
    }
    return this.current();
  }
}
