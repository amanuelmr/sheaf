import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, useColorScheme, type AppStateStatus } from 'react-native';
import type { DocId, MetadataPatch } from '@sheaf/core';
import { DocumentStore, SqlEventLog, type OutboxRow, type SqlDriver } from '@sheaf/store';
import type { SheafClient } from '@sheaf/client';
import { SheafAdapter, createClient } from '../adapters/api';
import { deviceLockAvailable, unlockDevice } from '../adapters/auth';
import { openDatabase, type Database } from '../adapters/database';
import type { ServerConfig } from '../adapters/credentials';
import { engineFiles } from '../adapters/files';
import {
  addProfile,
  activeProfileId,
  databaseNameFor,
  listProfiles,
  loadProfile,
  migrateLegacyConnection,
  removeProfile,
  setActiveProfile,
  type ProfileSummary,
} from '../adapters/profiles';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSetting,
  type AppSettings,
} from '../adapters/settings';
import { syncBackgroundTaskRegistration } from './background-sync';
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
  /** Every named connection this phone knows about, active one included. */
  profiles: readonly ProfileSummary[];
  activeProfileId: string | null;
  /** Add a new named connection and switch to it -- also how the very first one is made. */
  connect: (input: { name: string; baseUrl: string; token: string }) => Promise<void>;
  /** Switch which connection is active. Its own event log, opened fresh. */
  switchProfile: (id: string) => Promise<void>;
  /**
   * Forget a connection: its token, and its place in the list. What it captured
   * stays on disk, in its own database file, exactly as `disconnect` always left
   * a single connection's captures alone.
   */
  removeProfileById: (id: string) => Promise<void>;
  /** Forget the *active* connection. Kept for the screens already built around it. */
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
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [outbox, setOutbox] = useState<readonly OutboxRow[]>([]);
  const [offline, setOffline] = useState(false);
  const [lockAvailable, setLockAvailable] = useState(false);
  const [locked, setLocked] = useState(false);

  // Not state: closing the previous profile's database is bookkeeping around a
  // switch, not something a re-render should ever depend on.
  const openDatabaseRef = useRef<Database | null>(null);

  const palette = scheme === 'dark' ? palettes.dark : palettes.light;

  const refresh = useCallback(async () => {
    if (store === null) return;
    setOutbox(await store.outbox());
    setOffline(service?.connectivity === 'offline');
  }, [store, service]);

  /**
   * Open one profile's own database and make it the one everything else reads
   * from. The one seam every way of changing the active profile goes through --
   * first boot, a deliberate switch, and losing the active profile to
   * `removeProfileById` all end up here, so none of them can disagree about what
   * "switched to profile X" actually does.
   */
  const bootProfile = useCallback(async (id: string): Promise<void> => {
    const profile = await loadProfile(id);
    if (profile === null) {
      setServer(null);
      setStore(null);
      setDriver(null);
      setBoot('needs-server');
      return;
    }

    setOutbox([]); // stale rows from another profile are worse than a blank list
    const database = await openDatabase(databaseNameFor(id));
    const documentStore = new DocumentStore(new SqlEventLog(database));
    const loadedSettings = await loadSettings(database);

    const previous = openDatabaseRef.current;
    openDatabaseRef.current = database;
    if (previous !== null && previous !== database) await previous.close();

    setDriver(database);
    setStore(documentStore);
    setSettings(loadedSettings);
    setServer({ baseUrl: profile.baseUrl, token: profile.token });
    setBoot('ready');
  }, []);

  /**
   * Remove a profile, and if it was the active one, decide what "active" means
   * now: whatever is left, or `needs-server` when nothing is. The one place
   * `removeProfileById` and `disconnect` -- forgetting *some* connection versus
   * forgetting *the* connection -- share, so neither can drift from what the
   * other does once a removal empties the list.
   */
  const removeAndReactivate = useCallback(
    async (id: string): Promise<void> => {
      await removeProfile(id);
      const remaining = await listProfiles();
      setProfiles(remaining);
      if (id !== activeId) return; // someone else's connection; nothing else changes

      const next = remaining[0];
      if (next === undefined) {
        setActiveId(null);
        setServer(null);
        setStore(null);
        setDriver(null);
        setBoot('needs-server');
        return;
      }
      setBoot('starting');
      await setActiveProfile(next.id);
      setActiveId(next.id);
      await bootProfile(next.id);
    },
    [activeId, bootProfile],
  );

  // Boot: migrate whoever was connected before profiles existed, then open
  // whichever profile is active. Nothing about scanning depends on being
  // connected, but everything about *which* database to scan into does.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await migrateLegacyConnection();
        const [list, active] = await Promise.all([listProfiles(), activeProfileId()]);
        if (cancelled) return;
        setProfiles(list);
        setActiveId(active);
        if (active === null) {
          setBoot('needs-server');
          return;
        }
        await bootProfile(active);
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
  }, [bootProfile]);

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

  // The setting is the source of truth for whether the OS should be asked for
  // an occasional background tick; this just makes that ask match it, every
  // time the setting changes and once at boot in case reality had drifted
  // from it (a reinstall, an OS-level permission revoked outside the app).
  useEffect(() => {
    if (boot !== 'ready') return;
    void syncBackgroundTaskRegistration(settings.backgroundSyncEnabled);
  }, [boot, settings.backgroundSyncEnabled]);

  // The sync loop only exists once there is somewhere to sync to. Switching the
  // active profile changes `store` and `server` together, which tears this down
  // and stands a fresh one up for the new profile automatically -- nothing about
  // a switch has to know that this effect exists.
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
      profiles,
      activeProfileId: activeId,
      lockAvailable,
      locked,
      unlock: async () => {
        const ok = await unlockDevice();
        if (ok) setLocked(false);
        return ok;
      },
      refresh,
      connect: async (input) => {
        const created = await addProfile(input);
        setActiveId(created.id);
        setProfiles(await listProfiles());
        setBoot('starting');
        await bootProfile(created.id);
      },
      switchProfile: async (id) => {
        if (id === activeId) return;
        setBoot('starting');
        await setActiveProfile(id);
        setActiveId(id);
        await bootProfile(id);
      },
      removeProfileById: removeAndReactivate,
      disconnect: async () => {
        if (activeId !== null) await removeAndReactivate(activeId);
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
      profiles,
      activeId,
      lockAvailable,
      locked,
      driver,
      refresh,
      bootProfile,
      removeAndReactivate,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
