import { describe, expect, it } from 'vitest';
import { TILE_COLOR_IDS } from '@open-zone/shared';
import {
  PALETTE,
  SHADE_COUNT,
  defaultSourceColor,
  defaultZoneColor,
  shadeFor,
  shadeIndex,
} from '../src/designs/palette.ts';

/** WCAG contrast of a #rrggbb color against white. */
function contrastWithWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

describe('tile palette', () => {
  it('has 16 colors with 6 static shades each', () => {
    expect(Object.keys(PALETTE).sort()).toEqual([...TILE_COLOR_IDS].sort());
    for (const c of Object.values(PALETTE)) {
      expect(c.shades).toHaveLength(SHADE_COUNT);
      for (const hex of c.shades) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('goes from soft to deep as volume rises, keeping white text readable', () => {
    for (const [id, c] of Object.entries(PALETTE)) {
      const contrasts = c.shades.map(contrastWithWhite);
      for (let i = 1; i < contrasts.length; i++) {
        expect(contrasts[i], `${id} shade ${i}`).toBeGreaterThan(contrasts[i - 1]!);
      }
      expect(contrasts[0], `${id} softest`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('maps volume 0–38 onto the 6 shades', () => {
    expect([0, 6, 7, 12, 13, 19, 20, 25, 26, 32, 33, 38].map((v) => shadeIndex(v))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
    ]);
    expect(shadeFor('blue', 38)).toBe(PALETTE.blue.shades[5]);
  });

  it('has stable defaults for sources and zones', () => {
    expect([1, 2, 3, 4, 5, 6].map(defaultSourceColor)).toEqual([
      'blue',
      'orange',
      'emerald',
      'rose',
      'violet',
      'cyan',
    ]);
    const unit1 = [11, 12, 13, 14, 15, 16].map(defaultZoneColor);
    expect(new Set(unit1).size).toBe(6);
    expect(defaultZoneColor(21)).not.toBe(defaultZoneColor(16));
  });
});
