import NetInfo, { NetInfoStateType, type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import type { NetStatus, SyncPolicy } from '@sheaf/core';
import { SyncEngine, type EngineApi, type EngineFiles } from '@sheaf/engine';
import type { DocumentStore } from '@sheaf/store';

const TICK_INTERVAL_MS = 3_000;

export interface SyncServiceOptions {
  readonly store: DocumentStore;
  readonly api: EngineApi;
  readonly files: EngineFiles;
  readonly policy: () => SyncPolicy;
  readonly onChange: () => void;
}

/**
 * Keeps the engine ticking while the app is alive.
 *
 * Deliberately dumb: it decides *when* to ask, never *what* to do. Every decision
 * still comes from `next()`, so nothing here can invent a state transition.
 *
 * `resuming` is true for exactly the first tick of a process. That is what turns an
 * upload interrupted by a kill into a reconciliation instead of a blind re-send.
 */
export class SyncService {
  private readonly engine: SyncEngine;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNet: (() => void) | null = null;
  private appStateSubscription: { remove(): void } | null = null;
  private net: NetStatus = 'wifi';
  private firstTick = true;
  private ticking = false;

  constructor(private readonly options: SyncServiceOptions) {
    this.engine = new SyncEngine(options.store, {
      now: () => Date.now(),
      jitter: () => Math.random(),
      net: () => this.net,
      policy: options.policy,
      api: options.api,
      files: options.files,
    });
  }

  get sync(): SyncEngine {
    return this.engine;
  }

  get connectivity(): NetStatus {
    return this.net;
  }

  start(): void {
    this.unsubscribeNet = NetInfo.addEventListener((state) => {
      const previous = this.net;
      this.net = classify(state);
      // Connectivity returning is the one moment worth a free retry.
      if (previous === 'offline' && this.net !== 'offline') {
        void this.engine.retryAfterReconnect().then(() => this.tick());
      }
    });

    this.appStateSubscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') void this.tick();
    });

    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeNet?.();
    this.unsubscribeNet = null;
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  /** One pass over every document. Overlapping passes are skipped, not queued. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const resuming = this.firstTick;
    this.firstTick = false;
    try {
      await this.engine.tickAll(resuming);
    } finally {
      this.ticking = false;
      this.options.onChange();
    }
  }
}

function classify(state: NetInfoState): NetStatus {
  if (state.isConnected !== true) return 'offline';
  if (state.type === NetInfoStateType.wifi || state.type === NetInfoStateType.ethernet) {
    return 'wifi';
  }
  return 'cellular';
}
