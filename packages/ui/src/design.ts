/**
 * Visual designs. Each has its own path and shares every behavior (store,
 * actions, mirror editor, settings); only layout and styling differ.
 *   /tiles     tiles    — room tiles with volume rings, colored by source (default)
 *   /studio    studio   — warm, light-first list with source chips
 *   /console   console  — dark mixing-desk channel strips with faders
 *   /classic   classic  — the functional test layout
 *
 * "/" opens the design last used on this device (Tiles the first time).
 * Visiting a design's own path makes it this device's design, so a home-screen
 * app (which always starts at "/") reopens whatever was picked last, while a
 * wall tablet can still bookmark /console.
 */
export type Design = 'classic' | 'studio' | 'console' | 'tiles';

export const DEFAULT_DESIGN: Design = 'tiles';

export const DESIGNS: Array<{ id: Design; label: string; root: string; blurb: string }> = [
  { id: 'tiles', label: 'Tiles', root: '/tiles/', blurb: 'Room tiles with volume rings' },
  { id: 'studio', label: 'Studio', root: '/studio/', blurb: 'Warm, calm list with source icons' },
  {
    id: 'console',
    label: 'Console',
    root: '/console/',
    blurb: 'Mixing-desk faders, great on tablets',
  },
  { id: 'classic', label: 'Classic', root: '/classic/', blurb: 'The original functional layout' },
];

const STORAGE_KEY = 'open-zone.design';

function isDesign(v: unknown): v is Design {
  return DESIGNS.some((d) => d.id === v);
}

/** The design named by the path, or null for "/" and unknown paths. */
export function designFromPath(pathname: string): Design | null {
  const first = pathname.split('/').filter(Boolean)[0];
  return isDesign(first) ? first : null;
}

function savedDesign(): Design | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isDesign(v) ? v : null;
  } catch {
    return null; // storage blocked (private mode etc.)
  }
}

function saveDesign(d: Design): void {
  try {
    localStorage.setItem(STORAGE_KEY, d);
  } catch {
    /* not persisted, but still used for this visit */
  }
}

const fromPath = designFromPath(location.pathname);
if (fromPath) saveDesign(fromPath);

export const design: Design = fromPath ?? savedDesign() ?? DEFAULT_DESIGN;

document.documentElement.dataset.design = design;
