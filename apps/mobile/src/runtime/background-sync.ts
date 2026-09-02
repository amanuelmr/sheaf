import NetInfo, { NetInfoStateType } from '@react-native-community/netinfo';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import type { NetStatus } from '@sheaf/core';
import { SyncEngine } from '@sheaf/engine';
import { DocumentStore, SqlEventLog } from '@sheaf/store';
import { SheafAdapter, createClient } from '../adapters/api';
import { openDatabase } from '../adapters/database';
import { engineFiles } from '../adapters/files';
import { databaseNameFor, loadActiveProfile } from '../adapters/profiles';
import { loadSettings } from '../adapters/settings';

export const BACKGROUND_SYNC_TASK = 'sheaf-background-sync';

function classify(state: Awaited<ReturnType<typeof NetInfo.fetch>>): NetStatus {
  if (state.isConnected !== true) return 'offline';
  return state.type === NetInfoStateType.wifi || state.type === NetInfoStateType.ethernet
    ? 'wifi'
    : 'cellular';
}

/**
 * Defined at module scope, not inside a component, because the OS can invoke
 * this without the React tree ever mounting -- there is no `AppProvider`, no
 * `SyncService`, nothing a screen set up. It rebuilds the same wiring
 * `SyncService` assembles for the foreground, from scratch, for whichever
 * profile happens to be active, then does exactly one pass rather than
 * starting a loop: the OS decides how long this call gets to run, not this
 * code.
 *
 * `resuming: true` on every call, not just the first one ever: this process
 * did not exist a moment ago and will not exist a moment from now, so it has
 * no idea whether an upload some earlier invocation started actually landed.
 * That is exactly the condition `resuming` exists to handle, and it only
 * changes anything for a document already `UPLOADING` -- everything else
 * proceeds exactly as the foreground would decide it.
 */
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const profile = await loadActiveProfile();
    if (profile === null) return BackgroundTask.BackgroundTaskResult.Success;

    const database = await openDatabase(databaseNameFor(profile.id));
    try {
      const store = new DocumentStore(new SqlEventLog(database));
      const settings = await loadSettings(database);
      const net = classify(await NetInfo.fetch());
      const server = { baseUrl: profile.baseUrl, token: profile.token };
      const api = new SheafAdapter(server, createClient(server));

      const engine = new SyncEngine(store, {
        now: () => Date.now(),
        jitter: () => Math.random(),
        net: () => net,
        policy: () => ({
          wifiOnly: settings.wifiOnly,
          keepLocalAfterSync: settings.keepLocalAfterSync,
        }),
        api,
        files: engineFiles,
      });
      await engine.tickAll(true);
    } finally {
      await database.close();
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    // Whatever went wrong, the log is exactly where the crash-recovery story
    // already says it should be: the next tick, foreground or background,
    // decides again from what is actually on disk. Nothing here invents an
    // outcome by guessing at one.
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * The setting is the source of truth; this just makes reality match it,
 * idempotently, so calling it every time `settings.backgroundSyncEnabled`
 * changes -- including "changed to the value it already was" on every boot --
 * is always safe.
 */
export async function syncBackgroundTaskRegistration(enabled: boolean): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (enabled && !registered) {
    // 15 minutes is the platform floor, not a promise: the OS decides the
    // actual cadence from battery, network conditions and how often the app
    // is used, the same restraint `minimumInterval` documents itself.
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: 15 });
  } else if (!enabled && registered) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}
