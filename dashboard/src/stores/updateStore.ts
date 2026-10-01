import { useSyncExternalStore } from 'react';
import { api } from './api';
import { store } from './store';
import { reportClientLog } from './workspaceStore';
import { errorDetailOf } from '../lib/errors';

/**
 * Where the update check stands. A check runs once when the app starts (unless the user turned the
 * automatic check off) and again whenever the About tab asks for one; the About tab and both badges
 * read this one state, so a result the app already has is on screen as soon as the page renders.
 */
export type UpdatePhase = 'idle' | 'latest' | 'available' | 'failed';

export type UpdateState = {
  /** How the last check ended; a check in flight leaves this alone. */
  phase: UpdatePhase;
  /** True while a request is on the wire, so the button can say so. */
  checking: boolean;
  /** The running build, as the backend reports it. */
  current: string;
  /** The newest release, empty until a check has seen one. */
  latest: string;
};

class UpdateStore {
  private state: UpdateState = { phase: 'idle', checking: false, current: '', latest: '' };
  private started = false;
  private running = false;
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.version;

  get current() {
    return this.state;
  }

  get hasUpdate() {
    return this.state.phase === 'available';
  }

  /**
   * The startup path: read the running version, then look for a release when the settings allow it.
   * A page that loads while a check is already running, or a second call from the shell's startup
   * effect, does not start a second one.
   */
  async initialize(auto: boolean) {
    if (this.started) return;
    this.started = true;
    await this.readVersion();
    if (auto) await this.check({ force: false });
  }

  /** The manual path, which the button drives. Re-entering while a check runs is ignored. */
  async check({ force }: { force: boolean }) {
    if (this.running) return;
    this.running = true;
    this.changed({ checking: true });
    try {
      const status = await store
        .dispatch(api.endpoints.getUpdateStatus.initiate({ force }))
        .unwrap();
      this.changed({
        phase: status.updateAvailable ? 'available' : 'latest',
        current: status.current || this.state.current,
        latest: status.latest,
      });
    } catch (reason: unknown) {
      this.changed({ phase: 'failed' });
      reportClientLog('update_check_failed', 'Update check failed', errorDetailOf(reason));
    } finally {
      this.running = false;
      this.changed({ checking: false });
    }
  }

  private async readVersion() {
    try {
      const status = await store.dispatch(api.endpoints.getStatus.initiate()).unwrap();
      if (status.appVersion) this.changed({ current: status.appVersion });
    } catch {
      // The About tab still renders; the version line fills in once the backend answers.
    }
  }

  private changed(next: Partial<UpdateState>) {
    this.state = { ...this.state, ...next };
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
}

export const update = new UpdateStore();

export function useUpdate() {
  useSyncExternalStore(update.subscribe, update.snapshot);
  return update;
}
