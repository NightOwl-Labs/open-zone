import { Icon, Sheet, Slider } from '../components.tsx';
import { roleOf, sourceLabel, zoneLabel } from '../format.ts';
import { useApp } from '../store.ts';
import {
  MirrorNote,
  SubControls,
  ToneControls,
  ZoneFacts,
  ZoneNameField,
  change,
  isFollowing,
  isSub,
  type ZoneDetailProps,
} from '../zoneParts.tsx';
import { SourceChips } from './SourceChips.tsx';
import { sourceHue, sourceIcon } from './visuals.ts';
import { VolumeRing } from './VolumeRing.tsx';

const MAX = 38;

/**
 * Tiles detail: the sheet opens with the same tinted hero as the tile —
 * gauge, name, source and power — then source chips, volume and tone.
 */
export function TileDetail({ zone, onClose }: ZoneDetailProps) {
  const z = useApp((s) => s.zones).find((x) => x.zone === zone);
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  if (!z) return null;
  const role = roleOf(zone, mirrors);
  const following = isFollowing(role);
  const s = z.state;
  const on = s?.power ?? false;
  const primary =
    role?.kind === 'follower' ? zones.find((x) => x.zone === role.group.primary) : undefined;
  const step = (d: number) => s && change(z, { volume: Math.max(0, Math.min(MAX, s.volume + d)) });

  const hero = (
    <div
      className={`td-hero${on ? ' on' : ''}${following ? ' following' : ''}${s?.mute ? ' muted' : ''}`}
      style={{ '--hue': sourceHue(s?.source) } as React.CSSProperties}
    >
      {s && (on || following) && (
        <VolumeRing value={s.volume} muted={s.mute} className="t-ring td-ring" />
      )}
      <div className="td-text">
        <h2>{zoneLabel(z)}</h2>
        <span className="t-sub">
          {isSub(role) ? (
            <>
              <Icon name="link" /> Subwoofer for {primary ? zoneLabel(primary) : ''}
            </>
          ) : following ? (
            <>
              <Icon name="link" /> Following {primary ? zoneLabel(primary) : ''}
            </>
          ) : !s ? (
            'Not read yet'
          ) : on ? (
            <>
              <Icon name={sourceIcon(sources, s.source)} /> {sourceLabel(sources, s.source)}
              {s.mute ? ' · muted' : ''}
            </>
          ) : (
            'Off'
          )}
        </span>
      </div>
      {s && !following && (
        <button
          type="button"
          className={`t-power td-power${on ? ' on' : ''}`}
          aria-label={`${zoneLabel(z)} power`}
          aria-pressed={on}
          onClick={() => change(z, { power: !on })}
        >
          <Icon name="power" />
        </button>
      )}
    </div>
  );

  return (
    <Sheet
      title={zoneLabel(z)}
      onClose={onClose}
      className={`sheet-tiles${on && !following ? ' tinted' : ''}`}
      style={{ '--hue': sourceHue(s?.source) } as React.CSSProperties}
      hero={hero}
    >
      {role?.kind === 'primary' || following ? <MirrorNote z={z} /> : null}
      {s && on && !following && (
        <>
          <div className="field">
            <span>Source</span>
            <SourceChips z={z} sources={sources} />
          </div>
          <div className="field">
            <span>Volume</span>
            <div className="td-volume">
              <button
                type="button"
                className="icon-btn"
                aria-label="Volume down"
                onClick={() => step(-1)}
              >
                <Icon name="minus" />
              </button>
              <Slider
                label={`${zoneLabel(z)} volume`}
                value={s.volume}
                min={0}
                max={MAX}
                onCommit={(v) => change(z, { volume: v })}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Volume up"
                onClick={() => step(1)}
              >
                <Icon name="plus" />
              </button>
              <button
                type="button"
                className={`icon-btn${s.mute ? ' active' : ''}`}
                aria-label={s.mute ? 'Unmute' : 'Mute'}
                aria-pressed={s.mute}
                onClick={() => change(z, { mute: !s.mute })}
              >
                <Icon name={s.mute ? 'muted' : 'speaker'} />
              </button>
            </div>
          </div>
          <SubControls z={z} />
          <ToneControls z={z} />
        </>
      )}
      {following && <SubControls z={z} />}
      {s && !on && !following && (
        <p className="muted-text td-off">Turn the zone on to choose a source and adjust volume.</p>
      )}
      <ZoneNameField z={z} />
      <ZoneFacts z={z} />
    </Sheet>
  );
}
