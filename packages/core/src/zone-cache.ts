import {
  SETTABLE_PROPS,
  type SettableProp,
  type ZoneId,
  type ZonePatch,
  type ZoneState,
} from '@open-zone/shared';

export type ObservedChanges = ZonePatch & { pa?: boolean; keypad?: boolean };

interface Entry {
  state: ZoneState;
  updatedAt: number;
}

const OBSERVED_PROPS = [...SETTABLE_PROPS, 'pa', 'keypad'] as const;

/**
 * Last known state per zone, plus a count of in-flight writes per property.
 *
 * Writes are marked pending the moment they are queued. Poll results for a
 * pending property are ignored, so a poll that was answered before the write
 * reached the wire can never roll the cache back (and trigger a bogus mirror
 * fan-out or detach).
 */
export class ZoneStateCache {
  private readonly entries = new Map<ZoneId, Entry>();
  private readonly pending = new Map<ZoneId, Map<SettableProp, number>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(zone: ZoneId): ZoneState | undefined {
    const e = this.entries.get(zone);
    return e ? { ...e.state } : undefined;
  }

  updatedAt(zone: ZoneId): number | null {
    return this.entries.get(zone)?.updatedAt ?? null;
  }

  clear(): void {
    this.entries.clear();
  }

  markPending(zone: ZoneId, props: readonly SettableProp[]): void {
    let m = this.pending.get(zone);
    if (!m) this.pending.set(zone, (m = new Map()));
    for (const p of props) m.set(p, (m.get(p) ?? 0) + 1);
  }

  clearPending(zone: ZoneId, props: readonly SettableProp[]): void {
    const m = this.pending.get(zone);
    if (!m) return;
    for (const p of props) {
      const n = (m.get(p) ?? 0) - 1;
      if (n > 0) m.set(p, n);
      else m.delete(p);
    }
    if (m.size === 0) this.pending.delete(zone);
  }

  isPending(zone: ZoneId, prop: SettableProp): boolean {
    return (this.pending.get(zone)?.get(prop) ?? 0) > 0;
  }

  pendingProps(zone: ZoneId): SettableProp[] {
    return [...(this.pending.get(zone)?.keys() ?? [])];
  }

  /**
   * Merge a state read from the hardware. Returns the properties that changed
   * (ignoring pending ones), or null when this is the first read of the zone.
   */
  applyObserved(state: ZoneState): ObservedChanges | null {
    const entry = this.entries.get(state.zone);
    if (!entry) {
      this.entries.set(state.zone, { state: { ...state }, updatedAt: this.now() });
      return null;
    }
    const changes: Record<string, number | boolean> = {};
    for (const prop of OBSERVED_PROPS) {
      if (prop !== 'pa' && prop !== 'keypad' && this.isPending(state.zone, prop)) continue;
      if (entry.state[prop] !== state[prop]) {
        (entry.state as unknown as Record<string, number | boolean>)[prop] = state[prop];
        changes[prop] = state[prop];
      }
    }
    entry.updatedAt = this.now();
    return changes as ObservedChanges;
  }

  /** Record an acknowledged write. Returns true when the value changed. */
  applyWrite(zone: ZoneId, prop: SettableProp, value: number | boolean): boolean {
    const entry = this.entries.get(zone);
    if (!entry) return false;
    entry.updatedAt = this.now();
    if (entry.state[prop] === value) return false;
    (entry.state as unknown as Record<string, number | boolean>)[prop] = value;
    return true;
  }
}
