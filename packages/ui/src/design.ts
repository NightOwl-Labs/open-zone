/**
 * Visual designs. Each lives at its own root path and shares every behavior
 * (store, actions, mirror editor, settings); only layout and styling differ.
 *   /          classic  — the functional test layout
 *   /studio    studio   — warm, light-first list with source chips
 *   /console   console  — dark mixing-desk channel strips with faders
 *   /tiles     tiles    — room tiles with volume rings, colored by source
 */
export type Design = 'classic' | 'studio' | 'console' | 'tiles';

export const DESIGNS: Array<{ id: Design; label: string; root: string; blurb: string }> = [
  { id: 'classic', label: 'Classic', root: '/', blurb: 'The original functional layout' },
  { id: 'studio', label: 'Studio', root: '/studio/', blurb: 'Warm, calm list with source icons' },
  {
    id: 'console',
    label: 'Console',
    root: '/console/',
    blurb: 'Mixing-desk faders, great on tablets',
  },
  { id: 'tiles', label: 'Tiles', root: '/tiles/', blurb: 'Room tiles with volume rings' },
];

export function designFromPath(pathname: string): Design {
  const first = pathname.split('/').filter(Boolean)[0];
  return DESIGNS.find((d) => d.id === first && d.id !== 'classic')?.id ?? 'classic';
}

export const design: Design = designFromPath(location.pathname);
export const designRoot = DESIGNS.find((d) => d.id === design)!.root;

document.documentElement.dataset.design = design;

// Home-screen installs should reopen the same design.
const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
if (manifest) manifest.href = `/api/v1/manifest.webmanifest?root=${encodeURIComponent(designRoot)}`;
