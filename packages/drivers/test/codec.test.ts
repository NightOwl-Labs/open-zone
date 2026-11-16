import { describe, expect, it } from 'vitest';
import {
  formatSet,
  formatStatus,
  formatUnitQuery,
  formatZoneQuery,
  parseCommand,
  parseStatusLines,
} from '../src/index.ts';

describe('monoprice codec', () => {
  it('formats queries', () => {
    expect(formatZoneQuery(11)).toBe('?11\r');
    expect(formatUnitQuery(2)).toBe('?20\r');
  });

  it('formats set commands', () => {
    expect(formatSet(11, 'volume', 20)).toBe('<11VO20\r');
    expect(formatSet(23, 'power', true)).toBe('<23PR01\r');
    expect(formatSet(36, 'source', 3)).toBe('<36CH03\r');
    expect(formatSet(12, 'dnd', false)).toBe('<12DT00\r');
    expect(() => formatSet(11, 'volume', 100)).toThrow(RangeError);
  });

  it('parses a status line with surrounding echo and prompts', () => {
    const raw = '?11\r\r\n#>1100010000200710121401\r\r\n#';
    expect(parseStatusLines(raw)).toEqual([
      {
        zone: 11,
        pa: false,
        power: true,
        mute: false,
        dnd: false,
        volume: 20,
        treble: 7,
        bass: 10,
        balance: 12,
        source: 14,
        keypad: true,
      },
    ]);
  });

  it('parses several status lines', () => {
    const raw = '?10\r\r\n#>1100000000100707100100\r\r\n#>1200010000150707100300\r\r\n#';
    expect(parseStatusLines(raw).map((s) => s.zone)).toEqual([11, 12]);
  });

  it('round-trips status formatting', () => {
    const s = {
      zone: 25,
      pa: true,
      power: true,
      mute: true,
      dnd: false,
      volume: 38,
      treble: 0,
      bass: 14,
      balance: 20,
      source: 6,
      keypad: false,
    };
    expect(parseStatusLines(formatStatus(s))).toEqual([s]);
  });

  it('parses commands (for the emulator)', () => {
    expect(parseCommand('?10')).toEqual({ kind: 'queryUnit', unit: 1 });
    expect(parseCommand('?34')).toEqual({ kind: 'queryZone', zone: 34 });
    expect(parseCommand('<11VO20')).toEqual({ kind: 'set', zone: 11, prop: 'volume', value: 20 });
    expect(parseCommand('<11XX20').kind).toBe('unknown');
  });
});
