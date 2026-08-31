import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, useColorScheme, type AppStateStatus } from 'react-native';
import type { DocId, MetadataPatch } from '@sheaf/core';
import { DocumentStore, SqlEventLog, type OutboxRow, type SqlDriver } from '@sheaf/store';
import type { SheafClient } from '@sheaf/client';
import { SheafAdapter, createClient } from '../adapters/api';
import { deviceLockAvailable, unlockDevice } from '../adapters/auth';
import { openDatabase } from '../adapters/database';
import {
  clearServerConfig,
  loadServerConfig,
  saveServerConfig,
  type ServerConfig,
} from '../adapters/credentials';
import { engineFiles } from '../adapters/files';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSetting,
  type AppSettings,
} from '../adapters/settings';
import { SyncService } from './sync-service';
import { palettes, type Palette } from '../theme';

type Boot = 'starting' | 'needs-server' | 'ready' | 'failed';

interface AppValue {
  boot: Boot;
  bootError: string | null;
  palette: Palette;
  settings: AppSettings;
  server: ServerConfig | null;
  outbox: readonly OutboxRow[];
  offline: boolean;
  store: DocumentStore | null;
  service: SyncService | null;
  adapter: SheafAdapter | null;
  /** The protocol client directly, for reads that are not part of the sync engine. */
  client: SheafClient | null;
  /** The raw SQL connection, for the archive cache -- it is not part of the log. */
  driver: SqlDriver | null;
  /** Whether this device even has a lock screen to borrow. */
  lockAvailable: boolean;
  /** True until the device's own unlock succeeds, whenever the setting is on. */
  locked: boolean;
  unlock: () => Promise<boolean>;
  refresh: () => Promise<void>;
  connect: (config: ServerConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  updateSetting: (key: keyof AppSettings, value: string | number | boolean) => Promise<void>;
  retry: (docId: DocId) => Promise<void>;
  accept: (docId: DocId, patch: MetadataPatch) => Promise<void>;
}

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp must be used inside AppProvider');
  return value;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const [boot, setBoot] = useState<Boot>('starting');
  const [bootError, setBootError] = useState<string | null>(null);
  const [driver, setDriver] = useState<SqlDriver | null>(null);
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [service, setService] = useState<SyncService | null>(null);
  const [adapter, setAdapter] = useState<SheafAdapter | null>(null);
  const [client, setClient] = useState<SheafClient | null>(null);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [outbox, setOutbox] = useState<readonly OutboxRow[]>([]);
  const [offline, setOffline] = useState(false);
  const [lockAvailable, setLockAvailable] = useState(false);
  const [locked, setLocked] = useState(false);

  const palette = scheme === 'dark' ? palettes.dark : palettes.light;

  const refresh = useCallback(async () => {
    if (store === null) return;
    setOutbox(await store.outbox());
    setOffline(service?.connectivity === 'offline');
  }, [store, service]);

  // Boot: open the database first, so captures are durable even with no server
  // configured. Nothing about scanning depends on being connected.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const database = await openDatabase();
        const documentStore = new DocumentStore(new SqlEventLog(database));
        const loaded = await loadSettings(database);
        const config = await loadServerConfig();
        if (cancelled) return;

        setDriver(database);
        setStore(documentStore);
        setSettings(loaded);
        setServer(config);
        setBoot(config === null ? 'needs-server' : 'ready');
      } catch (error) {
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : String(error));
          setBoot('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Check once whether this device even has a lock screen to borrow, and arm the
  // lock for this launch if the setting wants one. Hardware and enrollment do not
  // change while the app is running, so this never needs to run again on its own.
  useEffect(() => {
    if (boot !== 'ready' && boot !== 'needs-server') return;
    let cancelled = false;
    void deviceLockAvailable().then((available) => {
      if (cancelled) return;
      setLockAvailable(available);
      if (available && settings.appLockEnabled) setLocked(true);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `boot` alone, not on `settings.appLockEnabled`: this
    // arms the lock once, for this launch. Turning the toggle on mid-session should
    // not lock the screen out from under whoever just turned it on -- it takes
    // effect the next time the app is opened or backgrounded, same as the effect
    // below.
  }, [boot]);

  // Stepping away re-arms the lock. Coming back to the foreground does not bypass
  // it -- only a successful unlock does.
  useEffect(() => {
    if (!lockAvailable) return;
    const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status !== 'active' && settings.appLockEnabled) setLocked(true);
    });
    return () => subscription.remove();
  }, [lockAvailable, settings.appLockEnabled]);

  // The sync loop only exists once there is somewhere to sync to.
  useEffect(() => {
    if (store === null || server === null) return;
    const rawClient = createClient(server);
    const api = new SheafAdapter(server, rawClient);
    const running = new SyncService({
      store,
      api,
      files: engineFiles,
      policy: () => ({
        wifiOnly: settings.wifiOnly,
        keepLocalAfterSync: settings.keepLocalAfterSync,
      }),
      onChange: () => {
        void store.outbox().then(setOutbox);
      },
    });
    setAdapter(api);
    setClient(rawClient);
    setService(running);
    if (settings.autoSync) running.start();
    return () => {
      running.stop();
    };
  }, [store, server, settings.autoSync, settings.wifiOnly, settings.keepLocalAfterSync]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AppValue>(
    () => ({
      boot,
      bootError,
      palette,
      settings,
      server,
      outbox,
      offline,
      store,
      service,
      adapter,
      client,
      driver,
      lockAvailable,
      locked,
      unlock: async () => {
        const ok = await unlockDevice();
        if (ok) setLocked(false);
        return ok;
      },
      refresh,
      connect: async (config) => {
        await saveServerConfig(config);
        setServer(config);
        setBoot('ready');
      },
      disconnect: async () => {
        service?.stop();
        await clearServerConfig();
        setServer(null);
        setService(null);
        setClient(null);
        setBoot('needs-server');
      },
      updateSetting: async (key, next) => {
        if (driver === null) return;
        await saveSetting(driver, key, next);
        setSettings(await loadSettings(driver));
      },
      retry: async (docId) => {
        await service?.sync.requestRetry(docId);
        await service?.tick();
        await refresh();
      },
      accept: async (docId, patch) => {
        await service?.sync.acceptMetadata(docId, patch);
        await service?.tick();
        await refresh();
      },
    }),
    [
      boot,
      bootError,
      palette,
      settings,
      server,
      outbox,
      offline,
      store,
      service,
      adapter,
      client,
      lockAvailable,
      locked,
      driver,
      refresh,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
