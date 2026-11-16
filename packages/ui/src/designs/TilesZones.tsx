import { Icon } from '../components.tsx';
import { roleOf, sourceLabel, zoneLabel } from '../format.ts';
import { useApp } from '../store.ts';
import type { ZoneItemProps } from '../ZonesPage.tsx';
import { change, isFollowing } from '../zoneParts.tsx';
import { sourceHue, sourceIcon } from './visuals.ts';

const MAX = 38;

function VolumeRing({ value, muted }: { value: number; muted: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const arc = 0.75; // 270° gauge, open at the bottom
  const filled = (value / MAX) * arc * c;
  return (
    <svg className="t-ring" viewBox="0 0 64 64" aria-hidden>
      <circle
        cx="32"
        cy="32"
        r={r}
        className="t-ring-track"
        strokeDasharray={`${arc * c} ${c}`}
        transform="rotate(135 32 32)"
      />
      <circle
        cx="32"
        cy="32"
        r={r}
        className="t-ring-fill"
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(135 32 32)"
      />
      <text x="32" y="37" textAnchor="middle" className="t-ring-text">
        {muted ? '—' : value}
      </text>
    </svg>
  );
}

/** Tiles: rooms as colored tiles with a volume ring and quick −/mute/+ controls. */
export function RoomTile({ z, onOpen }: ZoneItemProps) {
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  const following = isFollowing(role);
  const s = z.state;
  const on = s?.power ?? false;
  const primary =
    role?.kind === 'follower' ? zones.find((x) => x.zone === role.group.primary) : undefined;
  const step = (d: number) => s && change(z, { volume: Math.max(0, Math.min(MAX, s.volume + d)) });
  return (
    <article
      className={`t-tile${on ? ' on' : ''}${following ? ' following' : ''}${s?.mute ? ' muted' : ''}`}
      style={{ '--hue': sourceHue(s?.source) } as React.CSSProperties}
    >
      <button
        type="button"
        className="t-open"
        onClick={onOpen}
        aria-label={`${zoneLabel(z)} details`}
      >
        <span className="t-name">{zoneLabel(z)}</span>
        <span className="t-sub">
          {following ? (
            <>
              <Icon name="link" /> {primary ? zoneLabel(primary) : 'Following'}
            </>
          ) : !s ? (
            'Not read yet'
          ) : on ? (
            <>
              <Icon name={sourceIcon(sources, s.source)} /> {sourceLabel(sources, s.source)}
            </>
          ) : (
            'Off'
          )}
        </span>
        {s && (on || following) && <VolumeRing value={s.volume} muted={s.mute} />}
        {role?.kind === 'primary' && role.group.enabled && (
          <span className="t-lead">Leads {role.group.followers.length}</span>
        )}
      </button>
      {s && !following && (
        <button
          type="button"
          className={`t-power${on ? ' on' : ''}`}
          aria-label={`${zoneLabel(z)} power`}
          aria-pressed={on}
          onClick={() => change(z, { power: !on })}
        >
          <Icon name="power" />
        </button>
      )}
      {on && !following && s && (
        <div className="t-quick">
          <button type="button" aria-label="Volume down" onClick={() => step(-1)}>
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className={s.mute ? 'active' : ''}
            aria-label={s.mute ? 'Unmute' : 'Mute'}
            aria-pressed={s.mute}
            onClick={() => change(z, { mute: !s.mute })}
          >
            <Icon name={s.mute ? 'muted' : 'speaker'} />
          </button>
          <button type="button" aria-label="Volume up" onClick={() => step(1)}>
            <Icon name="plus" />
          </button>
        </div>
      )}
    </article>
  );
}
