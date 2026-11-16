import { describe, expect, it } from 'vitest';
import type { ZoneState } from '@open-zone/shared';
import { ZoneStateCache } from '../src/index.ts';

const base: ZoneState = {
  zone: 11,
  pa: false,
  power: true,
  mute: false,
  dnd: false,
  volume: 10,
  treble: 7,
  bass: 7,
  balance: 10,
  source: 1,
  keypad: false,
};

describe('ZoneStateCache', () => {
  it('returns null on first observation, then only changed properties', () => {
    const c = new ZoneStateCache();
    expect(c.applyObserved(base)).toBeNull();
    expect(c.applyObserved(base)).toEqual({});
    expect(c.applyObserved({ ...base, volume: 12, keypad: true })).toEqual({
      volume: 12,
      keypad: true,
    });
  });

  it('ignores polled values for properties with writes in flight', () => {
    const c = new ZoneStateCache();
    c.applyObserved(base);
    c.markPending(11, ['volume']);
    // A poll answered before the write hit the wire still shows the old volume.
    expect(c.applyObserved({ ...base, volume: 10, source: 2 })).toEqual({ source: 2 });
    expect(c.applyWrite(11, 'volume', 30)).toBe(true);
    c.clearPending(11, ['volume']);
    expect(c.get(11)?.volume).toBe(30);
    expect(c.applyObserved({ ...base, volume: 30, source: 2 })).toEqual({});
  });

  it('counts overlapping pending writes', () => {
    const c = new ZoneStateCache();
    c.markPending(11, ['volume']);
    c.markPending(11, ['volume']);
    c.clearPending(11, ['volume']);
    expect(c.isPending(11, 'volume')).toBe(true);
    c.clearPending(11, ['volume']);
    expect(c.pendingProps(11)).toEqual([]);
  });
});
