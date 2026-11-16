/**
 * Monoprice 10761 (and rebadged 6-zone amps such as the Dayton DAX66 family)
 * RS-232 protocol codec. Pure functions only — no I/O.
 *
 * Wire format (per the manual and pymonoprice; verify with tools/oz-probe):
 *   Query zone:  "?11\r"            → echo, then "\r\n#>11PAPRMUDTVOTRBSBLCHLS\r\r\n#"
 *   Query unit:  "?10\r"            → echo, then one status line per zone, then "#"
 *   Set:         "<11VO20\r"        → echo, then "\r\n#"
 * Status digits after ">" (two each): zone, PA, power, mute, DND, volume,
 * treble, bass, balance, source, keypad.
 */
import type { ModelDescriptor, SettableProp, UnitId, ZoneId, ZoneState } from '@open-zone/shared';

export const MONOPRICE_10761: ModelDescriptor = {
  id: 'monoprice-10761',
  displayName: 'Monoprice 10761 6-Zone Amplifier',
  maxUnits: 3,
  zonesPerUnit: 6,
  sourceCount: 6,
  // Confirmed on hardware (oz-probe, 2026-11-16): writes to an off zone are acked but not applied.
  quirks: { ignoresSetsWhenOff: true },
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

export const PROP_CODES: Record<SettableProp, string> = {
  power: 'PR',
  mute: 'MU',
  dnd: 'DT',
  volume: 'VO',
  treble: 'TR',
  bass: 'BS',
  balance: 'BL',
  source: 'CH',
};

export const CODE_PROPS: Record<string, SettableProp> = Object.fromEntries(
  Object.entries(PROP_CODES).map(([prop, code]) => [code, prop as SettableProp]),
);

const two = (n: number) => String(n).padStart(2, '0');

export function formatZoneQuery(zone: ZoneId): string {
  return `?${zone}\r`;
}

export function formatUnitQuery(unit: UnitId): string {
  return `?${unit}0\r`;
}

export function formatSet(zone: ZoneId, prop: SettableProp, value: number | boolean): string {
  const v = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  if (!Number.isInteger(v) || v < 0 || v > 99) {
    throw new RangeError(`Cannot encode ${prop}=${String(value)}`);
  }
  return `<${zone}${PROP_CODES[prop]}${two(v)}\r`;
}

const STATUS_RE = />(\d{22})/g;

export function parseStatusDigits(digits: string): ZoneState {
  if (!/^\d{22}$/.test(digits)) throw new Error(`Malformed status: ${digits}`);
  const f = Array.from({ length: 11 }, (_, i) => Number(digits.slice(i * 2, i * 2 + 2)));
  const [zone, pa, power, mute, dnd, volume, treble, bass, balance, source, keypad] = f as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    zone,
    pa: pa === 1,
    power: power === 1,
    mute: mute === 1,
    dnd: dnd === 1,
    volume,
    treble,
    bass,
    balance,
    source,
    keypad: keypad === 1,
  };
}

/** Extract every status record in a chunk of received text. */
export function parseStatusLines(text: string): ZoneState[] {
  return Array.from(text.matchAll(STATUS_RE), (m) => parseStatusDigits(m[1]!));
}

export function formatStatus(s: ZoneState): string {
  const b = (x: boolean) => (x ? '01' : '00');
  return (
    '>' +
    two(s.zone) +
    b(s.pa) +
    b(s.power) +
    b(s.mute) +
    b(s.dnd) +
    two(s.volume) +
    two(s.treble) +
    two(s.bass) +
    two(s.balance) +
    two(s.source) +
    b(s.keypad)
  );
}

/** Parsed form of a command, used by the emulator. */
export type ParsedCommand =
  | { kind: 'queryZone'; zone: ZoneId }
  | { kind: 'queryUnit'; unit: UnitId }
  | { kind: 'set'; zone: ZoneId; prop: SettableProp; value: number }
  | { kind: 'unknown'; raw: string };

export function parseCommand(raw: string): ParsedCommand {
  const q = /^\?(\d)(\d)$/.exec(raw);
  if (q) {
    const unit = Number(q[1]);
    const idx = Number(q[2]);
    return idx === 0 ? { kind: 'queryUnit', unit } : { kind: 'queryZone', zone: unit * 10 + idx };
  }
  const s = /^<(\d{2})([A-Z]{2})(\d{2})$/.exec(raw);
  if (s && CODE_PROPS[s[2]!]) {
    return { kind: 'set', zone: Number(s[1]), prop: CODE_PROPS[s[2]!]!, value: Number(s[3]) };
  }
  return { kind: 'unknown', raw };
}
