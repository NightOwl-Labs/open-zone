import type { SourceView, TileColor, ZoneView } from '@open-zone/shared';
import { useApp } from '../store.ts';
import type { IconName } from '../components.tsx';
import { PALETTE, defaultSourceColor, defaultZoneColor, shadeFor } from './palette.ts';

/** Guess a source icon from its name. Purely presentational. */
const RULES: Array<[RegExp, IconName]> = [
  [/\b(tv|television|cable|satellite|roku|fire ?tv|apple ?tv|shield|projector)\b/i, 'tv'],
  [/(vinyl|turntable|record|phono|cd\b)/i, 'disc'],
  [/(radio|tuner|\bfm\b|\bam\b|sirius)/i, 'radio'],
  [/(game|xbox|playstation|\bps\d\b|switch|nintendo)/i, 'game'],
  [/(bluetooth|\bbt\b)/i, 'bluetooth'],
  [/(\bmic\b|page|paging|intercom|doorbell|announce)/i, 'mic'],
  [
    /(sonos|music|spotify|airplay|stream|bluesound|wiim|chromecast|heos|plex|roon|jukebox)/i,
    'music',
  ],
];

export function sourceIcon(sources: SourceView[], id: number | undefined): IconName {
  const name = sources.find((s) => s.source === id)?.name;
  if (!name) return 'input';
  return RULES.find(([re]) => re.test(name))?.[1] ?? 'input';
}

/** The color chosen for a source, or its default. */
export function sourceColor(sources: SourceView[], id: number | undefined): TileColor {
  if (!id) return 'blue';
  return sources.find((s) => s.source === id)?.color ?? defaultSourceColor(id);
}

/** The color chosen for a zone, or its default (used when tiles are colored by zone). */
export function ownZoneColor(z: Pick<ZoneView, 'zone' | 'color'>): TileColor {
  return z.color ?? defaultZoneColor(z.zone);
}

export function hueOf(color: TileColor): number {
  return PALETTE[color].hue;
}

/**
 * A zone's color under the current setting: its source's color, or its own.
 * Returns the hue (for accents in every design) and the volume shade (tiles).
 */
export function useZoneColor(z: ZoneView): { color: TileColor; hue: number; shade: string } {
  const mode = useApp((s) => s.config?.appearance.tileColors ?? 'source');
  const sources = useApp((s) => s.sources);
  const color = mode === 'zone' ? ownZoneColor(z) : sourceColor(sources, z.state?.source);
  return { color, hue: hueOf(color), shade: shadeFor(color, z.state?.volume ?? 0) };
}

/** CSS variables for a zone's tile or row. */
export function zoneColorStyle(c: { hue: number; shade: string }): React.CSSProperties {
  return { '--hue': c.hue, '--tile': c.shade } as React.CSSProperties;
}
