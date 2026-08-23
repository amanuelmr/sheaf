import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import type { DocId, MetadataPatch } from '@sheaf/core';
import { DocumentStore, SqlEventLog, type OutboxRow, type SqlDriver } from '@sheaf/store';
import { PaperlessAdapter, createClient } from '../adapters/api';
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
  adapter: PaperlessAdapter | null;
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
  const [adapter, setAdapter] = useState<PaperlessAdapter | null>(null);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [outbox, setOutbox] = useState<readonly OutboxRow[]>([]);
  const [offline, setOffline] = useState(false);

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

  // The sync loop only exists once there is somewhere to sync to.
  useEffect(() => {
    if (store === null || server === null) return;
    const paperless = new PaperlessAdapter(createClient(server), () => Date.now());
    const running = new SyncService({
      store,
      api: paperless,
      files: engineFiles,
      policy: () => ({
        wifiOnly: settings.wifiOnly,
        keepLocalAfterSync: settings.keepLocalAfterSync,
      }),
      onChange: () => {
        void store.outbox().then(setOutbox);
      },
    });
    setAdapter(paperless);
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
      driver,
      refresh,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
