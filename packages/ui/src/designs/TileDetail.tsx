import type { ZoneView } from '@open-zone/shared';
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
import { api } from '../api.ts';
import { NowPlayingCard, useNowPlaying } from '../nowPlaying.tsx';
import { ColorPicker } from '../ColorPicker.tsx';
import { run } from '../store.ts';
import { ownZoneColor, sourceColor, sourceIcon, useZoneColor, zoneColorStyle } from './visuals.ts';
import { VolumeRing } from './VolumeRing.tsx';

const MAX = 38;

/**
 * Tiles detail: the sheet opens with the same tinted hero as the tile —
 * gauge, name, source and power — then source chips, volume and tone.
 */
export function TileDetail({ zone, onClose }: ZoneDetailProps) {
  const z = useApp((s) => s.zones).find((x) => x.zone === zone);
  return z ? <TileSheet z={z} onClose={onClose} /> : null;
}

function TileSheet({ z, onClose }: { z: ZoneView; onClose: () => void }) {
  const zone = z.zone;
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const color = useZoneColor(z);
  const np = useNowPlaying(z);
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
      style={zoneColorStyle(color)}
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
      style={zoneColorStyle(color)}
      hero={hero}
    >
      {role?.kind === 'primary' || following ? <MirrorNote z={z} /> : null}
      {s && on && !following && (
        <>
          {np && <NowPlayingCard np={np} />}
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
      <TileColorField z={z} />
      <ZoneNameField z={z} />
      <ZoneFacts z={z} />
    </Sheet>
  );
}

/** Change this tile's color: the zone's own color, or (colored by source) its source's color. */
function TileColorField({ z }: { z: ZoneView }) {
  const mode = useApp((s) => s.config?.appearance.tileColors ?? 'source');
  const sources = useApp((s) => s.sources);
  if (mode === 'zone') {
    return (
      <div className="field">
        <span>Tile color</span>
        <ColorPicker
          label={zoneLabel(z)}
          value={ownZoneColor(z)}
          isDefault={!z.color}
          onChange={(color) => void run(() => api.updateZone(z.zone, { color }))}
        />
      </div>
    );
  }
  const src = z.state?.power ? sources.find((x) => x.source === z.state?.source) : undefined;
  if (!src) return null;
  return (
    <div className="field">
      <span>Source color</span>
      <ColorPicker
        label={sourceLabel(sources, src.source)}
        value={sourceColor(sources, src.source)}
        isDefault={!src.color}
        onChange={(color) => void run(() => api.updateSource(src.source, { color }))}
      />
      <span className="muted-text small">
        Tiles are colored by source, so this changes every zone playing it. Switch to coloring by
        zone in Settings → Colors.
      </span>
    </div>
  );
}
