import type { SourceView } from '@open-zone/shared';
import type { IconName } from '../components.tsx';

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

/** A stable hue per source number, used to tint tiles and chips. */
const HUES = [212, 28, 152, 330, 268, 188];
export function sourceHue(id: number | undefined): number {
  return id ? (HUES[(id - 1) % HUES.length] ?? 212) : 212;
}
