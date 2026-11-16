import { Icon, Toggle } from '../components.tsx';
import { roleOf, sourceLabel, zoneLabel } from '../format.ts';
import { useApp } from '../store.ts';
import type { ZoneItemProps } from '../ZonesPage.tsx';
import { FollowingLine, RoleBadge, VolumeRow, change, isFollowing } from '../zoneParts.tsx';
import { SourceChips } from './SourceChips.tsx';
import { sourceHue, sourceIcon } from './visuals.ts';

/** Studio: a calm list. Each zone leads with a source-colored icon; sources are chips. */
export function StudioRow({ z, onOpen }: ZoneItemProps) {
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  const following = isFollowing(role);
  const on = z.state?.power ?? false;
  const source = z.state?.source;
  return (
    <article
      className={`s-row${on ? ' on' : ''}${following ? ' following' : ''}${
        z.state?.mute ? ' muted' : ''
      }`}
      style={{ '--hue': sourceHue(source) } as React.CSSProperties}
    >
      <div className="s-head">
        <button type="button" className="s-avatar" onClick={onOpen} tabIndex={-1} aria-hidden>
          <Icon name={following ? 'link' : on ? sourceIcon(sources, source) : 'power'} />
        </button>
        <button type="button" className="s-title" onClick={onOpen}>
          <span className="name">{zoneLabel(z)}</span>
          {following ? (
            <FollowingLine role={role} zones={zones} />
          ) : (
            <>
              <span className="sub">
                {!z.state
                  ? 'Not read yet'
                  : on
                    ? `${sourceLabel(sources, source!)} · ${z.state.mute ? 'muted' : `vol ${z.state.volume}`}`
                    : 'Off'}
              </span>
              <RoleBadge role={role} zones={zones} />
            </>
          )}
        </button>
        {z.state && !following && (
          <Toggle
            label={`${zoneLabel(z)} power`}
            checked={on}
            onChange={(v) => change(z, { power: v })}
          />
        )}
      </div>
      {on && !following && (
        <div className="s-body">
          <SourceChips z={z} sources={sources} />
          <VolumeRow z={z} />
        </div>
      )}
    </article>
  );
}
