import {
  MAX_VOLUME_OFFSET,
  type SourceView,
  type ZonePatch,
  type ZoneView,
} from '@open-zone/shared';
import { api } from './api.ts';
import { Icon, NameInput, Sheet, Slider, Toggle } from './components.tsx';
import {
  balanceLabel,
  groupLabel,
  levelLabel,
  offsetLabel,
  roleOf,
  sourceLabel,
  toneLabel,
  zoneLabel,
  type Role,
} from './format.ts';
import { run, setFollowerLevel, setZone, useApp } from './store.ts';
import { NowPlayingCard, useNowPlaying } from './nowPlaying.tsx';

/*
 * Behavior shared by every design: zone commands, mirror badges, source and
 * volume controls, and the zone detail sheet. Designs only change layout.
 */

export function change(z: ZoneView, patch: ZonePatch): void {
  void setZone(z.zone, patch);
}

/** A follower of an enabled mirror is driven by its primary: no controls of its own. */
export function isFollowing(role: Role): role is Extract<NonNullable<Role>, { kind: 'follower' }> {
  return role?.kind === 'follower' && role.group.enabled;
}

/** A subwoofer follower: follows its primary but has its own level and tone. */
export function isSub(role: Role): role is Extract<NonNullable<Role>, { kind: 'follower' }> {
  return isFollowing(role) && role.sub;
}

export function FollowingLine({ role, zones }: { role: Role; zones: ZoneView[] }) {
  if (!isFollowing(role)) return null;
  const primary = zones.find((z) => z.zone === role.group.primary);
  const name = primary ? zoneLabel(primary) : `Zone ${role.group.primary}`;
  return (
    <span className="badge follower">
      <Icon name="link" />
      {role.sub ? (
        <>
          Subwoofer for {name} · level {levelLabel(role.volumeOffset)}
        </>
      ) : (
        <>
          Following {name}
          {role.volumeOffset ? ` · volume ${offsetLabel(role.volumeOffset)}` : ''}
        </>
      )}
    </span>
  );
}

/**
 * − level + for a subwoofer follower. The level is the sub zone's volume
 * relative to its primary, so the sub keeps tracking the room's volume.
 */
export function SubLevel({
  groupId,
  zone,
  value,
  label = 'Sub',
  className = '',
}: {
  groupId: string;
  zone: number;
  value: number;
  label?: string;
  className?: string;
}) {
  const set = (v: number) => {
    const next = Math.max(-MAX_VOLUME_OFFSET, Math.min(MAX_VOLUME_OFFSET, v));
    if (next !== value) void setFollowerLevel(groupId, zone, next);
  };
  return (
    <div className={`sub-level ${className}`} role="group" aria-label={`${label} level`}>
      <button type="button" aria-label={`${label} quieter`} onClick={() => set(value - 1)}>
        <Icon name="minus" />
      </button>
      <output aria-live="polite">
        <span className="sub-level-label">{label}</span> {levelLabel(value)}
      </output>
      <button type="button" aria-label={`${label} louder`} onClick={() => set(value + 1)}>
        <Icon name="plus" />
      </button>
    </div>
  );
}

export function RoleBadge({ role, zones }: { role: Role; zones: ZoneView[] }) {
  if (!role) return null;
  if (role.kind === 'follower') {
    // Paused group: the zone is independent again, just note the membership.
    return role.group.enabled ? null : (
      <span className="badge follower paused">
        <Icon name="link" />
        {groupLabel(role.group, zones)} · paused
      </span>
    );
  }
  const n = role.group.followers.length;
  return (
    <span className={`badge primary${role.group.enabled ? '' : ' paused'}`}>
      <Icon name="link" />
      {groupLabel(role.group, zones)} · leads {n} {n === 1 ? 'zone' : 'zones'}
      {role.group.enabled ? '' : ' · paused'}
    </span>
  );
}

/** Enabled sources, plus the zone's current source if it has been disabled. */
export function SourceSelect({ z, sources }: { z: ZoneView; sources: SourceView[] }) {
  if (!z.state) return null;
  const current = z.state.source;
  const options = sources.filter((s) => s.enabled || s.source === current);
  return (
    <select
      className="select"
      aria-label={`${zoneLabel(z)} source`}
      value={current}
      onChange={(e) => change(z, { source: Number(e.currentTarget.value) })}
    >
      {options.map((s) => (
        <option key={s.source} value={s.source} disabled={!s.enabled}>
          {sourceLabel(sources, s.source)}
          {s.enabled ? '' : ' (disabled)'}
        </option>
      ))}
    </select>
  );
}

export function VolumeRow({ z }: { z: ZoneView }) {
  if (!z.state) return null;
  const s = z.state;
  return (
    <div className="vol-row">
      <button
        type="button"
        className={`icon-btn${s.mute ? ' active' : ''}`}
        aria-label={s.mute ? 'Unmute' : 'Mute'}
        aria-pressed={s.mute}
        onClick={() => change(z, { mute: !s.mute })}
      >
        <Icon name={s.mute ? 'muted' : 'speaker'} />
      </button>
      <Slider
        label={`${zoneLabel(z)} volume`}
        value={s.volume}
        min={0}
        max={38}
        onCommit={(v) => change(z, { volume: v })}
      />
    </div>
  );
}

/** Explains why a follower has no controls, or shows a primary's mirror badge. */
export function MirrorNote({ z }: { z: ZoneView }) {
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  if (isSub(role)) {
    return (
      <p className="note">
        <FollowingLine role={role} zones={zones} />
        <br />
        This zone feeds a subwoofer. It follows its primary&apos;s power, source and volume; set its
        level and tone here. The level is relative to the primary, so the sub keeps up when the room
        gets louder or quieter.
      </p>
    );
  }
  if (isFollowing(role)) {
    return (
      <p className="note">
        <FollowingLine role={role} zones={zones} />
        <br />
        This zone copies its primary. To control it on its own, remove it from the mirror or pause
        the mirror on the Mirrors tab. The volume offset is set there too.
      </p>
    );
  }
  return role ? (
    <p className="note">
      <RoleBadge role={role} zones={zones} />
    </p>
  ) : null;
}

/** Treble, bass, balance and (unless `dnd` is false) do-not-disturb. */
export function ToneControls({ z, dnd = true }: { z: ZoneView; dnd?: boolean }) {
  const s = z.state;
  if (!s) return null;
  return (
    <>
      <div className="field">
        <span>Treble</span>
        <Slider
          label="Treble"
          value={s.treble}
          min={0}
          max={14}
          format={(v) => toneLabel(v)}
          onCommit={(v) => change(z, { treble: v })}
        />
      </div>
      <div className="field">
        <span>Bass</span>
        <Slider
          label="Bass"
          value={s.bass}
          min={0}
          max={14}
          format={(v) => toneLabel(v)}
          onCommit={(v) => change(z, { bass: v })}
        />
      </div>
      <div className="field">
        <span>Balance</span>
        <Slider
          label="Balance"
          value={s.balance}
          min={0}
          max={20}
          format={balanceLabel}
          onCommit={(v) => change(z, { balance: v })}
        />
      </div>
      {dnd && (
        <div className="field-row">
          <span>Do not disturb</span>
          <Toggle label="Do not disturb" checked={s.dnd} onChange={(v) => change(z, { dnd: v })} />
        </div>
      )}
    </>
  );
}

/**
 * Subwoofer controls for a detail sheet. On a primary: a level row per sub it
 * leads. On a sub follower: its level plus its own treble, bass and balance.
 */
export function SubControls({ z }: { z: ZoneView }) {
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  if (isSub(role)) {
    return (
      <>
        <div className="field">
          <span>Sub level</span>
          <SubLevel
            groupId={role.group.id}
            zone={z.zone}
            value={role.volumeOffset}
            className="sheet-sub-level"
          />
        </div>
        {z.state?.power ? (
          <ToneControls z={z} dnd={false} />
        ) : (
          <p className="muted-text">Tone controls appear when the primary zone is on.</p>
        )}
      </>
    );
  }
  if (role?.kind !== 'primary' || !role.group.enabled) return null;
  const subs = role.group.followers.filter((c) => c.sub);
  return (
    <>
      {subs.map((c) => {
        const sz = zones.find((x) => x.zone === c.zone);
        return (
          <div className="field" key={c.zone}>
            <span>{subs.length > 1 && sz ? `Sub level · ${zoneLabel(sz)}` : 'Sub level'}</span>
            <SubLevel
              groupId={role.group.id}
              zone={c.zone}
              value={c.volumeOffset}
              className="sheet-sub-level"
            />
          </div>
        );
      })}
    </>
  );
}

export function ZoneNameField({ z }: { z: ZoneView }) {
  return (
    <div className="field">
      <span>Name</span>
      <NameInput
        label="Zone name"
        value={z.name}
        placeholder={`Zone ${z.zone}`}
        onSave={(name) => void run(() => api.updateZone(z.zone, { name }))}
      />
    </div>
  );
}

/** Read-only status. Zone and unit numbers live in Settings, not here. */
export function ZoneFacts({ z }: { z: ZoneView }) {
  const sources = useApp((s) => s.sources);
  const s = z.state;
  return (
    <dl className="facts">
      {s && (
        <>
          <dt>Now</dt>
          <dd>
            {s.power ? 'On' : 'Off'} · {sourceLabel(sources, s.source)} · volume {s.volume}
            {s.mute ? ' · muted' : ''}
          </dd>
        </>
      )}
      <dt>Wall keypad</dt>
      <dd>{s ? (s.keypad ? 'Connected' : 'None') : '—'}</dd>
      <dt>PA input</dt>
      <dd>{s ? (s.pa ? 'Active' : 'Idle') : '—'}</dd>
      <dt>Last read</dt>
      <dd>{z.updatedAt ? new Date(z.updatedAt).toLocaleTimeString() : '—'}</dd>
    </dl>
  );
}

export interface ZoneDetailProps {
  zone: number;
  onClose: () => void;
}

export function ZoneDetail({ zone, onClose }: ZoneDetailProps) {
  const z = useApp((s) => s.zones).find((x) => x.zone === zone);
  return z ? <ZoneSheet z={z} onClose={onClose} /> : null;
}

function ZoneSheet({ z, onClose }: { z: ZoneView; onClose: () => void }) {
  const zone = z.zone;
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const np = useNowPlaying(z);
  const following = isFollowing(roleOf(zone, mirrors));
  const s = z.state;
  return (
    <Sheet title={zoneLabel(z)} onClose={onClose}>
      <MirrorNote z={z} />
      {!s ? (
        <p className="muted-text">This zone hasn&apos;t been read from the amp yet.</p>
      ) : (
        !following && (
          <>
            <div className="field-row">
              <span>Power</span>
              <Toggle label="Power" checked={s.power} onChange={(v) => change(z, { power: v })} />
            </div>
            {s.power ? (
              <>
                {np && <NowPlayingCard np={np} />}
                <div className="field">
                  <span>Source</span>
                  <SourceSelect z={z} sources={sources} />
                </div>
                <div className="field">
                  <span>Volume</span>
                  <VolumeRow z={z} />
                </div>
                <SubControls z={z} />
                <ToneControls z={z} />
              </>
            ) : (
              // The amp ignores settings sent to a zone that is off.
              <p className="muted-text">Turn the zone on to choose a source and adjust sound.</p>
            )}
          </>
        )
      )}
      {following && <SubControls z={z} />}
      <ZoneNameField z={z} />
      <ZoneFacts z={z} />
    </Sheet>
  );
}
