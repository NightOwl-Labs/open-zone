import type { MirrorGroup, SourceView, ZoneView } from '@open-zone/shared';

export function zoneLabel(z: Pick<ZoneView, 'zone' | 'name'>): string {
  return z.name ?? `Zone ${z.zone}`;
}

export function sourceLabel(sources: SourceView[], id: number): string {
  return sources.find((s) => s.source === id)?.name ?? `Source ${id}`;
}

/** Tone value 0..14 (center 7) → "−3", "0", "+2". */
export function toneLabel(v: number, center = 7): string {
  const d = v - center;
  return d === 0 ? '0' : d > 0 ? `+${d}` : `−${-d}`;
}

/** Balance 0..20 (center 10) → "L4", "C", "R2". */
export function balanceLabel(v: number): string {
  const d = v - 10;
  return d === 0 ? 'C' : d < 0 ? `L${-d}` : `R${d}`;
}

export function offsetLabel(n: number): string {
  return n === 0 ? '' : n > 0 ? `+${n}` : `−${-n}`;
}

export type Role =
  | { kind: 'master'; group: MirrorGroup }
  | { kind: 'child'; group: MirrorGroup; volumeOffset: number }
  | null;

export function roleOf(zone: number, mirrors: MirrorGroup[]): Role {
  for (const g of mirrors) {
    if (g.master === zone) return { kind: 'master', group: g };
    const c = g.children.find((x) => x.zone === zone);
    if (c) return { kind: 'child', group: g, volumeOffset: c.volumeOffset };
  }
  return null;
}

export function groupLabel(g: MirrorGroup, zones: ZoneView[]): string {
  if (g.name) return g.name;
  const m = zones.find((z) => z.zone === g.master);
  return `Mirror of ${m ? zoneLabel(m) : `Zone ${g.master}`}`;
}
