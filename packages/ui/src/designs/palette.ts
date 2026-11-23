import type { TileColor } from '@open-zone/shared';

/**
 * The 16 tile colors. Each has 6 fixed shades, from soft (low volume) to deep
 * (high volume): saturation rises and lightness falls as the volume goes up.
 * Every shade keeps white tile text readable (contrast 4.6:1 at the softest,
 * 10:1 at the deepest). `hue` tints accents in the other designs.
 */
export const PALETTE: Record<TileColor, { label: string; hue: number; shades: readonly string[] }> =
  {
    red: {
      label: 'Red',
      hue: 0,
      shades: ['#b75858', '#b44242', '#a93434', '#9c2828', '#901d1d', '#841515'],
    },
    orange: {
      label: 'Orange',
      hue: 24,
      shades: ['#a5663b', '#99582e', '#8d4d21', '#834217', '#773910', '#6d3109'],
    },
    amber: {
      label: 'Amber',
      hue: 38,
      shades: ['#936f31', '#876224', '#7b5719', '#704d11', '#65440a', '#5b3c05'],
    },
    lime: {
      label: 'Lime',
      hue: 85,
      shades: ['#647d3f', '#577133', '#4c6527', '#425b1f', '#395118', '#324912'],
    },
    green: {
      label: 'Green',
      hue: 130,
      shades: ['#498152', '#3c7445', '#31693a', '#285e31', '#1f5428', '#194c22'],
    },
    emerald: {
      label: 'Emerald',
      hue: 155,
      shades: ['#408166', '#327459', '#28694e', '#1f5e44', '#18543b', '#124b33'],
    },
    teal: {
      label: 'Teal',
      hue: 174,
      shades: ['#388079', '#2c736c', '#226861', '#1a5d57', '#12534d', '#0d4a44'],
    },
    cyan: {
      label: 'Cyan',
      hue: 190,
      shades: ['#377e8d', '#2a7280', '#1f6675', '#165b69', '#0f515f', '#094955'],
    },
    sky: {
      label: 'Sky',
      hue: 202,
      shades: ['#3e7b9f', '#306e93', '#246388', '#1a587d', '#124e72', '#0c4669'],
    },
    blue: {
      label: 'Blue',
      hue: 216,
      shades: ['#4d76b3', '#3f69aa', '#315da0', '#275395', '#1d498c', '#154082'],
    },
    indigo: {
      label: 'Indigo',
      hue: 236,
      shades: ['#6b6fb4', '#5a61b5', '#4b52b9', '#3e46b6', '#333baf', '#2932a5'],
    },
    violet: {
      label: 'Violet',
      hue: 258,
      shades: ['#7f68b3', '#7458b4', '#6948b8', '#5f3cb0', '#5431a8', '#4b289e'],
    },
    purple: {
      label: 'Purple',
      hue: 280,
      shades: ['#9262ab', '#8a51a7', '#7f439d', '#753894', '#6b2e8a', '#622580'],
    },
    magenta: {
      label: 'Magenta',
      hue: 305,
      shades: ['#a857a2', '#9d4896', '#923b8a', '#872f80', '#7b2674', '#711e6a'],
    },
    rose: {
      label: 'Rose',
      hue: 340,
      shades: ['#b65576', '#b14166', '#a53359', '#99274d', '#8c1d42', '#811539'],
    },
    slate: {
      label: 'Slate',
      hue: 215,
      shades: ['#6c7684', '#5f6979', '#545e6d', '#4a5464', '#414b5a', '#394352'],
    },
  };

export const SHADE_COUNT = 6;

/** Which shade a volume uses: 0–6 → 0, 7–12 → 1, 13–19 → 2, 20–25 → 3, 26–32 → 4, 33–38 → 5. */
export function shadeIndex(volume: number, max = 38): number {
  return Math.max(0, Math.min(SHADE_COUNT - 1, Math.floor((volume * SHADE_COUNT) / (max + 1))));
}

export function shadeFor(color: TileColor, volume: number): string {
  return PALETTE[color].shades[shadeIndex(volume)]!;
}

/** Default color per source number (matches the hues used before colors were configurable). */
const SOURCE_DEFAULTS: readonly TileColor[] = [
  'blue',
  'orange',
  'emerald',
  'rose',
  'violet',
  'cyan',
];
export function defaultSourceColor(source: number): TileColor {
  return SOURCE_DEFAULTS[(source - 1) % SOURCE_DEFAULTS.length] ?? 'blue';
}

/** Default color per zone: neighbouring zones get clearly different colors. */
const ZONE_DEFAULTS: readonly TileColor[] = [
  'blue',
  'orange',
  'emerald',
  'rose',
  'violet',
  'amber',
  'cyan',
  'red',
  'green',
  'magenta',
  'sky',
  'lime',
  'indigo',
  'teal',
  'purple',
  'slate',
];
export function defaultZoneColor(zone: number): TileColor {
  const unit = Math.floor(zone / 10);
  const index = (unit - 1) * 6 + (zone % 10) - 1;
  return ZONE_DEFAULTS[((index % 16) + 16) % 16]!;
}
