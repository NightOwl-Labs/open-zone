import type { SourceView, ZoneView } from '@open-zone/shared';
import { Icon } from '../components.tsx';
import { sourceLabel, zoneLabel } from '../format.ts';
import { change } from '../zoneParts.tsx';
import { hueOf, sourceColor, sourceIcon } from './visuals.ts';

/**
 * Source picker as tappable chips. Same rules as the classic select: enabled
 * sources only, plus the zone's current source if it has been disabled.
 */
export function SourceChips({ z, sources }: { z: ZoneView; sources: SourceView[] }) {
  if (!z.state) return null;
  const current = z.state.source;
  const options = sources.filter((s) => s.enabled || s.source === current);
  return (
    <div className="chip-row" role="radiogroup" aria-label={`${zoneLabel(z)} source`}>
      {options.map((s) => (
        <button
          type="button"
          key={s.source}
          role="radio"
          aria-checked={s.source === current}
          disabled={!s.enabled}
          className={`src-chip${s.source === current ? ' active' : ''}`}
          style={{ '--hue': hueOf(sourceColor(sources, s.source)) } as React.CSSProperties}
          onClick={() => s.source !== current && change(z, { source: s.source })}
        >
          <Icon name={sourceIcon(sources, s.source)} />
          <span>{sourceLabel(sources, s.source)}</span>
        </button>
      ))}
    </div>
  );
}
