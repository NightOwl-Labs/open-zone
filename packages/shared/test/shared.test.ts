import { describe, expect, it } from 'vitest';
import {
  PatchValidationError,
  defaultConfig,
  diffSettings,
  isValidZone,
  parseConfig,
  validatePatch,
  zonesForUnits,
  type ModelDescriptor,
} from '../src/index.ts';

const model: ModelDescriptor = {
  id: 'test',
  displayName: 'Test',
  maxUnits: 3,
  zonesPerUnit: 6,
  sourceCount: 6,
  properties: {
    power: { type: 'bool' },
    mute: { type: 'bool' },
    dnd: { type: 'bool' },
    volume: { type: 'int', min: 0, max: 38 },
    treble: { type: 'int', min: 0, max: 14, center: 7 },
    bass: { type: 'int', min: 0, max: 14, center: 7 },
    balance: { type: 'int', min: 0, max: 20, center: 10 },
    source: { type: 'int', min: 1, max: 6 },
  },
};

describe('config', () => {
  it('fills defaults from an empty object', () => {
    const c = defaultConfig();
    expect(c.polling).toEqual({
      mirrorMasterMs: 500,
      mirrorChildAuditMs: 5000,
      interactiveMs: 2000,
    });
    expect(c.device.transport).toEqual({ type: 'serial', path: '/dev/amp0', baudRate: 9600 });
    expect(c.mirrors).toEqual([]);
  });

  it('accepts zone and source names', () => {
    const c = parseConfig({
      zones: { '11': { name: 'Kitchen' } },
      sources: { '1': { name: 'Sonos' } },
    });
    expect(c.zones['11']?.name).toBe('Kitchen');
    expect(c.sources['1']?.name).toBe('Sonos');
  });

  it('rejects malformed zone keys and unknown schema versions', () => {
    expect(() => parseConfig({ zones: { kitchen: { name: 'x' } } })).toThrow();
    expect(() => parseConfig({ schemaVersion: 99 })).toThrow();
  });

  it('defaults mirror child offsets to 0', () => {
    const c = parseConfig({ mirrors: [{ id: 'g', master: 11, children: [{ zone: 12 }] }] });
    expect(c.mirrors[0]).toEqual({
      id: 'g',
      enabled: true,
      master: 11,
      children: [{ zone: 12, volumeOffset: 0 }],
    });
  });
});

describe('model helpers', () => {
  it('validates zone ids', () => {
    expect(isValidZone(model, 11)).toBe(true);
    expect(isValidZone(model, 36)).toBe(true);
    expect(isValidZone(model, 17)).toBe(false);
    expect(isValidZone(model, 40)).toBe(false);
    expect(isValidZone(model, 10)).toBe(false);
  });

  it('lists zones for units', () => {
    expect(zonesForUnits(model, [1, 3])).toEqual([11, 12, 13, 14, 15, 16, 31, 32, 33, 34, 35, 36]);
  });

  it('validates patches against ranges', () => {
    expect(validatePatch(model, { volume: 20, power: true })).toEqual({ volume: 20, power: true });
    expect(() => validatePatch(model, { volume: 39 })).toThrow(PatchValidationError);
    expect(() => validatePatch(model, { source: 0 })).toThrow(/source/);
    expect(() => validatePatch(model, { power: 1 })).toThrow(/boolean/);
    expect(() => validatePatch(model, { pa: true })).toThrow(/not a settable/);
  });

  it('diffs settings', () => {
    const a = {
      power: true,
      mute: false,
      dnd: false,
      volume: 10,
      treble: 7,
      bass: 7,
      balance: 10,
      source: 1,
    };
    expect(diffSettings(a, { ...a, volume: 12, source: 3 })).toEqual({ volume: 12, source: 3 });
  });
});
