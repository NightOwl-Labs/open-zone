import type { SourceView, ZonePatch, ZoneView } from '@open-zone/shared';
import { api } from './api.ts';
import { Icon, NameInput, Sheet, Slider, Toggle } from './components.tsx';
import {
  balanceLabel,
  groupLabel,
  offsetLabel,
  roleOf,
  sourceLabel,
  toneLabel,
  zoneLabel,
  type Role,
} from './format.ts';
import { run, setZone, useApp } from './store.ts';

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

export function FollowingLine({ role, zones }: { role: Role; zones: ZoneView[] }) {
  if (!isFollowing(role)) return null;
  const primary = zones.find((z) => z.zone === role.group.primary);
  return (
    <span className="badge follower">
      <Icon name="link" />
      Following {primary ? zoneLabel(primary) : `Zone ${role.group.primary}`}
      {role.volumeOffset ? ` · volume ${offsetLabel(role.volumeOffset)}` : ''}
    </span>
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

/** Treble, bass, balance and do-not-disturb. */
export function ToneControls({ z }: { z: ZoneView }) {
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
      <div className="field-row">
        <span>Do not disturb</span>
        <Toggle label="Do not disturb" checked={s.dnd} onChange={(v) => change(z, { dnd: v })} />
      </div>
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
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  if (!z) return null;
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
                <div className="field">
                  <span>Source</span>
                  <SourceSelect z={z} sources={sources} />
                </div>
                <div className="field">
                  <span>Volume</span>
                  <VolumeRow z={z} />
                </div>
                <ToneControls z={z} />
              </>
            ) : (
              // The amp ignores settings sent to a zone that is off.
              <p className="muted-text">Turn the zone on to choose a source and adjust sound.</p>
            )}
          </>
        )
      )}
      <ZoneNameField z={z} />
      <ZoneFacts z={z} />
    </Sheet>
  );
}
