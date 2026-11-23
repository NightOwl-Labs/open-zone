import { Icon } from '../components.tsx';
import { roleOf, sourceLabel, subsLedBy, zoneLabel } from '../format.ts';
import { useApp } from '../store.ts';
import type { ZoneItemProps } from '../ZonesPage.tsx';
import { SubLevel, change, isFollowing, isSub } from '../zoneParts.tsx';
import { sourceHue, sourceIcon } from './visuals.ts';
import { VolumeRing } from './VolumeRing.tsx';

const MAX = 38;

/**
 * Tiles: rooms as colored tiles with a volume ring and quick −/mute/+ controls.
 * A room that leads a subwoofer zone gets a second row for the sub level; the
 * sub's own tile shows the same row.
 */
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
  const sub = isSub(role) ? role : null;
  // Quick sub level: on the room tile (first sub it leads) or on the sub's own tile.
  const led = subsLedBy(z.zone, mirrors)[0];
  const quickSub = !on
    ? null
    : sub
      ? { groupId: sub.group.id, zone: z.zone, value: sub.volumeOffset }
      : led
        ? { groupId: led.group.id, zone: led.follower.zone, value: led.follower.volumeOffset }
        : null;
  return (
    <article
      className={`t-tile${on ? ' on' : ''}${following ? ' following' : ''}${sub ? ' sub' : ''}${s?.mute ? ' muted' : ''}${quickSub && !sub ? ' has-sub' : ''}`}
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
          {sub ? (
            <>
              <Icon name="link" /> Sub · {primary ? zoneLabel(primary) : 'Following'}
            </>
          ) : following ? (
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
      {quickSub && (
        <SubLevel
          groupId={quickSub.groupId}
          zone={quickSub.zone}
          value={quickSub.value}
          className={`t-sub-level${sub ? ' own' : ''}`}
        />
      )}
    </article>
  );
}
