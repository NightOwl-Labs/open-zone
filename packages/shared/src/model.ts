/**
 * Device-independent description of a multi-zone amplifier.
 *
 * Every driver publishes a ModelDescriptor. The core and UIs read ranges and
 * zone layout from it rather than hard-coding a specific amp.
 */

/** Two-digit zone id: unit * 10 + zone-in-unit (e.g. 11..16, 21..26, 31..36). */
export type ZoneId = number;
/** Stacked unit number, 1-based. */
export type UnitId = number;
/** Source (input) number, 1-based. Sources are shared across stacked units. */
export type SourceId = number;

export const SETTABLE_PROPS = [
  'power',
  'mute',
  'dnd',
  'volume',
  'treble',
  'bass',
  'balance',
  'source',
] as const;
export type SettableProp = (typeof SETTABLE_PROPS)[number];

export const BOOL_PROPS = ['power', 'mute', 'dnd'] as const satisfies readonly SettableProp[];
export const INT_PROPS = [
  'volume',
  'treble',
  'bass',
  'balance',
  'source',
] as const satisfies readonly SettableProp[];
export type BoolProp = (typeof BOOL_PROPS)[number];
export type IntProp = (typeof INT_PROPS)[number];

export interface ZoneSettings {
  power: boolean;
  mute: boolean;
  dnd: boolean;
  volume: number;
  treble: number;
  bass: number;
  balance: number;
  source: SourceId;
}

/** Full zone status as reported by the hardware. */
export interface ZoneState extends ZoneSettings {
  zone: ZoneId;
  /** Public-address input is active (read-only). */
  pa: boolean;
  /** A wall keypad is connected to this zone (read-only). */
  keypad: boolean;
}

export type ZonePatch = Partial<ZoneSettings>;

export interface BoolSpec {
  type: 'bool';
}
export interface IntSpec {
  type: 'int';
  min: number;
  max: number;
  /** Neutral position for tone/balance controls. */
  center?: number;
}
export type PropertySpec = BoolSpec | IntSpec;

export interface ModelDescriptor {
  id: string;
  displayName: string;
  maxUnits: number;
  zonesPerUnit: number;
  sourceCount: number;
  properties: { [K in BoolProp]: BoolSpec } & { [K in IntProp]: IntSpec };
}

export function isBoolProp(prop: SettableProp): prop is BoolProp {
  return (BOOL_PROPS as readonly string[]).includes(prop);
}

export function unitOf(zone: ZoneId): UnitId {
  return Math.floor(zone / 10);
}

export function zonesForUnit(model: ModelDescriptor, unit: UnitId): ZoneId[] {
  return Array.from({ length: model.zonesPerUnit }, (_, i) => unit * 10 + i + 1);
}

export function zonesForUnits(model: ModelDescriptor, units: readonly UnitId[]): ZoneId[] {
  return units.flatMap((u) => zonesForUnit(model, u));
}

export function isValidZone(model: ModelDescriptor, zone: ZoneId): boolean {
  const unit = unitOf(zone);
  const idx = zone % 10;
  return (
    Number.isInteger(zone) &&
    unit >= 1 &&
    unit <= model.maxUnits &&
    idx >= 1 &&
    idx <= model.zonesPerUnit
  );
}

export function clampProp(model: ModelDescriptor, prop: IntProp, value: number): number {
  const spec = model.properties[prop];
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

export function settingsOf(state: ZoneState): ZoneSettings {
  const { power, mute, dnd, volume, treble, bass, balance, source } = state;
  return { power, mute, dnd, volume, treble, bass, balance, source };
}

/** Settable properties whose values differ between two settings objects. */
export function diffSettings(from: ZoneSettings, to: ZoneSettings): ZonePatch {
  const patch: Record<string, number | boolean> = {};
  for (const prop of SETTABLE_PROPS) {
    if (from[prop] !== to[prop]) patch[prop] = to[prop];
  }
  return patch as ZonePatch;
}

export class PatchValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid zone patch: ${issues.join('; ')}`);
    this.name = 'PatchValidationError';
    this.issues = issues;
  }
}

/** Validate a patch against a model's property ranges. Throws PatchValidationError. */
export function validatePatch(model: ModelDescriptor, patch: unknown): ZonePatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new PatchValidationError(['patch must be an object']);
  }
  const issues: string[] = [];
  const out: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTABLE_PROPS as readonly string[]).includes(key)) {
      issues.push(`${key}: not a settable property`);
      continue;
    }
    const prop = key as SettableProp;
    const spec = model.properties[prop];
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') issues.push(`${prop}: expected boolean`);
      else out[prop] = value;
    } else if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push(`${prop}: expected integer`);
    } else if (value < spec.min || value > spec.max) {
      issues.push(`${prop}: ${value} outside ${spec.min}..${spec.max}`);
    } else {
      out[prop] = value;
    }
  }
  if (issues.length) throw new PatchValidationError(issues);
  return out as ZonePatch;
}
