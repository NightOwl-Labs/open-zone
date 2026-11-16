/**
 * Pure mirror-group rules. The Controller supplies state and performs I/O;
 * everything here is deterministic and unit-testable.
 */
import {
  clampProp,
  diffSettings,
  isValidZone,
  settingsOf,
  type DetachReason,
  type MirrorGroup,
  type ModelDescriptor,
  type SettableProp,
  type UnitId,
  type ZoneId,
  type ZonePatch,
  type ZoneSettings,
  type ZoneState,
  unitOf,
} from '@open-zone/shared';

/** What a child zone should be set to, given its master and learned volume offset. */
export function expectedChildSettings(
  model: ModelDescriptor,
  master: ZoneSettings,
  volumeOffset: number,
): ZoneSettings {
  return {
    ...settingsOf(master as ZoneState),
    volume: clampProp(model, 'volume', master.volume + volumeOffset),
  };
}

export type ChildVerdict =
  | { kind: 'in-sync' }
  | { kind: 'offset'; volumeOffset: number }
  | { kind: 'detach'; reason: DetachReason; property?: SettableProp };

/**
 * Backup rule for a child that changed outside the mirror (the setup check
 * should prevent this, since children have no keypad):
 *   - a keypad shows up             → detach
 *   - only volume differs           → learn a new volume offset
 *   - anything else differs         → detach
 * Properties with writes still in flight are ignored. While both master and
 * child are powered off only power is compared — amps may ignore or not
 * report other settings on an idle zone.
 */
export function evaluateChild(
  model: ModelDescriptor,
  master: ZoneState,
  child: ZoneState,
  volumeOffset: number,
  ignore: readonly SettableProp[] = [],
): ChildVerdict {
  if (child.keypad) return { kind: 'detach', reason: 'keypad-detected' };
  const expected = expectedChildSettings(model, master, volumeOffset);
  if (!expected.power && !child.power) return { kind: 'in-sync' };
  const diff = diffSettings(settingsOf(child), expected);
  const props = (Object.keys(diff) as SettableProp[]).filter((p) => !ignore.includes(p));
  if (props.length === 0) return { kind: 'in-sync' };
  const other = props.find((p) => p !== 'volume');
  if (other) return { kind: 'detach', reason: 'property-changed', property: other };
  return { kind: 'offset', volumeOffset: child.volume - master.volume };
}

/**
 * Order writes for a zone: power-on goes first (so later settings land on a
 * live zone), power-off goes last (so settings land before it idles).
 */
export function orderWrites(patch: ZonePatch): Array<[SettableProp, number | boolean]> {
  const entries = Object.entries(patch) as Array<[SettableProp, number | boolean]>;
  const rest = entries.filter(([p]) => p !== 'power');
  if (patch.power === undefined) return rest;
  return patch.power ? [['power', true], ...rest] : [...rest, ['power', false]];
}

export class MirrorValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid mirror group: ${issues.join('; ')}`);
    this.name = 'MirrorValidationError';
    this.issues = issues;
  }
}

/**
 * Structural validation of a candidate group against the other groups.
 * Keypad checks need live hardware state and are done by the Controller.
 */
export function validateGroupShape(
  model: ModelDescriptor,
  units: readonly UnitId[],
  candidate: Pick<MirrorGroup, 'id' | 'master' | 'children'>,
  others: readonly MirrorGroup[],
): string[] {
  const issues: string[] = [];
  const installed = (z: ZoneId) => isValidZone(model, z) && units.includes(unitOf(z));
  const zones = [candidate.master, ...candidate.children.map((c) => c.zone)];
  for (const z of zones) if (!installed(z)) issues.push(`zone ${z} is not an installed zone`);
  if (candidate.children.some((c) => c.zone === candidate.master)) {
    issues.push('a zone cannot mirror itself');
  }
  const childZones = candidate.children.map((c) => c.zone);
  if (new Set(childZones).size !== childZones.length) issues.push('duplicate child zones');
  for (const g of others) {
    if (g.id === candidate.id) continue;
    const taken = new Set([g.master, ...g.children.map((c) => c.zone)]);
    for (const z of zones) {
      if (taken.has(z)) issues.push(`zone ${z} already belongs to mirror group ${g.id}`);
    }
  }
  return issues;
}
