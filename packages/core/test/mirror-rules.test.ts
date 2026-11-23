import { describe, expect, it } from 'vitest';
import type { MirrorGroup, ZoneState } from '@open-zone/shared';
import { MONOPRICE_10761 as model } from '@open-zone/drivers';
import {
  evaluateFollower,
  expectedFollowerSettings,
  orderWrites,
  validateGroupShape,
} from '../src/index.ts';

const zone = (z: number, over: Partial<ZoneState> = {}): ZoneState => ({
  zone: z,
  pa: false,
  power: true,
  mute: false,
  dnd: false,
  volume: 20,
  treble: 7,
  bass: 7,
  balance: 10,
  source: 2,
  keypad: false,
  ...over,
});

describe('expectedFollowerSettings', () => {
  it('copies the primary and applies a clamped volume offset', () => {
    expect(expectedFollowerSettings(model, zone(11), 5).volume).toBe(25);
    expect(expectedFollowerSettings(model, zone(11, { volume: 36 }), 5).volume).toBe(38);
    expect(expectedFollowerSettings(model, zone(11, { volume: 2 }), -5).volume).toBe(0);
    expect(expectedFollowerSettings(model, zone(11), 0)).not.toHaveProperty('keypad');
  });
  it("keeps a sub follower's own treble, bass and balance", () => {
    const own = zone(16, { treble: 0, bass: 12, balance: 10, source: 6, volume: 3 });
    expect(expectedFollowerSettings(model, zone(11, { bass: 4 }), 3, own)).toMatchObject({
      treble: 0,
      bass: 12,
      balance: 10,
      source: 2,
      volume: 23,
    });
  });
});

describe('evaluateFollower', () => {
  const primary = zone(11);
  it('is in sync when the follower matches', () => {
    expect(evaluateFollower(model, primary, zone(12), 0)).toEqual({ kind: 'in-sync' });
    expect(evaluateFollower(model, primary, zone(12, { volume: 24 }), 4)).toEqual({
      kind: 'in-sync',
    });
  });
  it('learns an offset when only volume differs', () => {
    expect(evaluateFollower(model, primary, zone(12, { volume: 15 }), 0)).toEqual({
      kind: 'offset',
      volumeOffset: -5,
    });
  });
  it('detaches when anything else differs', () => {
    expect(evaluateFollower(model, primary, zone(12, { source: 4, volume: 30 }), 0)).toEqual({
      kind: 'detach',
      reason: 'property-changed',
      property: 'source',
    });
  });
  it('detaches when a keypad appears', () => {
    expect(evaluateFollower(model, primary, zone(12, { keypad: true }), 0)).toMatchObject({
      reason: 'keypad-detected',
    });
  });
  it('ignores properties with writes in flight', () => {
    expect(evaluateFollower(model, primary, zone(12, { source: 4 }), 0, ['source'])).toEqual({
      kind: 'in-sync',
    });
  });
  it('lets a sub follower differ in tone but not in anything else', () => {
    const tuned = zone(16, { treble: 0, bass: 13, balance: 12 });
    expect(evaluateFollower(model, primary, tuned, 0, [], true)).toEqual({ kind: 'in-sync' });
    expect(evaluateFollower(model, primary, { ...tuned, volume: 23 }, 0, [], true)).toEqual({
      kind: 'offset',
      volumeOffset: 3,
    });
    expect(evaluateFollower(model, primary, { ...tuned, dnd: true }, 0, [], true)).toMatchObject({
      kind: 'detach',
      property: 'dnd',
    });
    expect(evaluateFollower(model, primary, tuned, 0)).toMatchObject({
      kind: 'detach',
      property: 'treble',
    });
  });
  it('only compares power while both zones are off', () => {
    const off = zone(11, { power: false });
    expect(
      evaluateFollower(model, off, zone(12, { power: false, source: 5, volume: 3 }), 0),
    ).toEqual({
      kind: 'in-sync',
    });
    expect(evaluateFollower(model, off, zone(12, { power: true }), 0)).toMatchObject({
      kind: 'detach',
      property: 'power',
    });
  });
});

describe('orderWrites', () => {
  it('puts power-on first and power-off last', () => {
    expect(orderWrites({ volume: 5, power: true, source: 2 }).map(([p]) => p)).toEqual([
      'power',
      'volume',
      'source',
    ]);
    expect(orderWrites({ power: false, volume: 5 }).map(([p]) => p)).toEqual(['volume', 'power']);
  });
});

describe('validateGroupShape', () => {
  const existing: MirrorGroup[] = [
    { id: 'a', enabled: true, primary: 21, followers: [{ zone: 22, volumeOffset: 0 }] },
  ];
  const v = (primary: number, followers: number[], id = 'new') =>
    validateGroupShape(
      model,
      [1, 2],
      { id, primary, followers: followers.map((zone) => ({ zone, volumeOffset: 0 })) },
      existing,
    );

  it('accepts a valid group', () => expect(v(11, [12, 13])).toEqual([]));
  it('rejects zones on missing units', () =>
    expect(v(11, [31]).join()).toMatch(/31 is not an installed/));
  it('rejects self-mirroring and duplicates', () => {
    expect(v(11, [11]).join()).toMatch(/itself/);
    expect(v(11, [12, 12]).join()).toMatch(/duplicate/);
  });
  it('rejects zones already in another group (no chains)', () => {
    expect(v(22, [23]).join()).toMatch(/22 already belongs/);
    expect(v(11, [21]).join()).toMatch(/21 already belongs/);
  });
  it('lets a group keep its own zones on edit', () => expect(v(21, [22, 23], 'a')).toEqual([]));
});
