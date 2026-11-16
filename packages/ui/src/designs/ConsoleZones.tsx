import { Icon, Slider } from '../components.tsx';
import { offsetLabel, roleOf, zoneLabel } from '../format.ts';
import { useApp } from '../store.ts';
import type { ZoneItemProps } from '../ZonesPage.tsx';
import { SourceSelect, change, isFollowing } from '../zoneParts.tsx';
import { sourceHue } from './visuals.ts';

/**
 * Console: one mixing-desk channel strip per zone — power LED, source,
 * mute, vertical fader, readout and a name plate that opens the details.
 */
export function ConsoleStrip({ z, onOpen }: ZoneItemProps) {
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  const following = isFollowing(role);
  const s = z.state;
  const on = s?.power ?? false;
  const primary =
    role?.kind === 'follower' ? zones.find((x) => x.zone === role.group.primary) : undefined;
  return (
    <article
      className={`c-strip${on ? ' on' : ''}${following ? ' following' : ''}${s?.mute ? ' muted' : ''}`}
      style={{ '--hue': sourceHue(s?.source) } as React.CSSProperties}
    >
      <div className="c-tag">
        {role?.kind === 'primary' && role.group.enabled
          ? 'LEAD'
          : following
            ? 'FOLLOW'
            : String(z.zone)}
      </div>
      <button
        type="button"
        className={`c-led${on ? ' on' : ''}`}
        aria-label={`${zoneLabel(z)} power`}
        aria-pressed={on}
        disabled={!s || following}
        onClick={() => change(z, { power: !on })}
      >
        <Icon name="power" />
      </button>
      <fieldset className="c-controls" disabled={!s || !on || following}>
        {following ? (
          <div className="c-follow" title={`Following ${primary ? zoneLabel(primary) : ''}`}>
            ↳ {primary ? zoneLabel(primary) : `Zone ${role?.group.primary}`}
          </div>
        ) : (
          <SourceSelect z={z} sources={sources} />
        )}
        <button
          type="button"
          className={`c-mute${s?.mute ? ' active' : ''}`}
          aria-label={s?.mute ? 'Unmute' : 'Mute'}
          aria-pressed={s?.mute ?? false}
          onClick={() => s && change(z, { mute: !s.mute })}
        >
          M
        </button>
        <div className="c-fader">
          <Slider
            vertical
            hideValue
            label={`${zoneLabel(z)} volume`}
            value={s?.volume ?? 0}
            min={0}
            max={38}
            onCommit={(v) => change(z, { volume: v })}
          />
        </div>
      </fieldset>
      <div className="c-readout" aria-hidden>
        {s ? String(s.volume).padStart(2, '0') : '--'}
        {following && role?.kind === 'follower' && role.volumeOffset ? (
          <small>{offsetLabel(role.volumeOffset)}</small>
        ) : null}
      </div>
      <button type="button" className="c-name" onClick={onOpen}>
        {zoneLabel(z)}
      </button>
    </article>
  );
}
