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

function change(z: ZoneView, patch: ZonePatch): void {
  void setZone(z.zone, patch);
}

/** A child of an enabled mirror is driven by its master: no controls of its own. */
function isFollowing(role: Role): role is Extract<NonNullable<Role>, { kind: 'child' }> {
  return role?.kind === 'child' && role.group.enabled;
}

function FollowingLine({ role, zones }: { role: Role; zones: ZoneView[] }) {
  if (!isFollowing(role)) return null;
  const master = zones.find((z) => z.zone === role.group.master);
  return (
    <span className="badge child">
      <Icon name="link" />
      Following {master ? zoneLabel(master) : `Zone ${role.group.master}`}
      {role.volumeOffset ? ` · volume ${offsetLabel(role.volumeOffset)}` : ''}
    </span>
  );
}

function RoleBadge({ role, zones }: { role: Role; zones: ZoneView[] }) {
  if (!role) return null;
  if (role.kind === 'child') {
    // Paused group: the zone is independent again, just note the membership.
    return role.group.enabled ? null : (
      <span className="badge child paused">
        <Icon name="link" />
        {groupLabel(role.group, zones)} · paused
      </span>
    );
  }
  const n = role.group.children.length;
  return (
    <span className={`badge master${role.group.enabled ? '' : ' paused'}`}>
      <Icon name="link" />
      {groupLabel(role.group, zones)} · leads {n} {n === 1 ? 'zone' : 'zones'}
      {role.group.enabled ? '' : ' · paused'}
    </span>
  );
}

/** Enabled sources, plus the zone's current source if it has been disabled. */
function SourceSelect({ z, sources }: { z: ZoneView; sources: SourceView[] }) {
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

function VolumeRow({ z }: { z: ZoneView }) {
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

function ZoneCard({ z, onOpen }: { z: ZoneView; onOpen: () => void }) {
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  const following = isFollowing(role);
  const on = z.state?.power ?? false;
  return (
    <article
      className={`card zone${on && !following ? ' on' : ''}${following ? ' following' : ''}${
        z.state?.mute ? ' muted' : ''
      }`}
    >
      <div className="zone-head">
        <button type="button" className="zone-title" onClick={onOpen}>
          <span className="name">{zoneLabel(z)}</span>
          {following ? (
            <FollowingLine role={role} zones={zones} />
          ) : (
            <>
              <span className="sub">
                {z.state ? (on ? sourceLabel(sources, z.state.source) : 'Off') : 'Not read yet'}
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
        <div className="zone-body">
          <SourceSelect z={z} sources={sources} />
          <VolumeRow z={z} />
        </div>
      )}
    </article>
  );
}

function ZoneDetail({ zone, onClose }: { zone: number; onClose: () => void }) {
  const z = useApp((s) => s.zones).find((x) => x.zone === zone);
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  if (!z) return null;
  const role = roleOf(zone, mirrors);
  const following = isFollowing(role);
  const s = z.state;
  return (
    <Sheet title={zoneLabel(z)} onClose={onClose}>
      {following ? (
        <p className="note">
          <FollowingLine role={role} zones={zones} />
          <br />
          This zone copies its master. To control it on its own, remove it from the mirror or pause
          the mirror on the Mirrors tab. The volume offset is set there too.
        </p>
      ) : (
        role && (
          <p className="note">
            <RoleBadge role={role} zones={zones} />
          </p>
        )
      )}
      {!s ? (
        <p className="muted-text">This zone hasn&apos;t been read from the amp yet.</p>
      ) : (
        !following && (
          <>
            <div className="field-row">
              <span>Power</span>
              <Toggle label="Power" checked={s.power} onChange={(v) => change(z, { power: v })} />
            </div>
            <div className="field">
              <span>Source</span>
              <SourceSelect z={z} sources={sources} />
            </div>
            <div className="field">
              <span>Volume</span>
              <VolumeRow z={z} />
            </div>
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
              <Toggle
                label="Do not disturb"
                checked={s.dnd}
                onChange={(v) => change(z, { dnd: v })}
              />
            </div>
          </>
        )
      )}
      <div className="field">
        <span>Name</span>
        <NameInput
          label="Zone name"
          value={z.name}
          placeholder={`Zone ${z.zone}`}
          onSave={(name) => void run(() => api.renameZone(z.zone, name))}
        />
      </div>
      <dl className="facts">
        <dt>Zone</dt>
        <dd>
          {z.zone} (unit {Math.floor(z.zone / 10)})
        </dd>
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
    </Sheet>
  );
}

export function ZonesPage({
  open,
  onOpen,
  onClose,
}: {
  open: number | null;
  onOpen: (zone: number) => void;
  onClose: () => void;
}) {
  const zones = useApp((s) => s.zones);
  const system = useApp((s) => s.system);
  if (zones.length === 0) {
    return (
      <div className="empty">
        <p>No zones yet.</p>
        <p className="muted-text">
          {system?.connection.status === 'connected'
            ? 'The amplifier reported no zones.'
            : `Waiting for the amplifier${system?.connection.error ? `: ${system.connection.error}` : '…'}`}
        </p>
      </div>
    );
  }
  const units = [...new Set(zones.map((z) => Math.floor(z.zone / 10)))];
  return (
    <>
      {units.map((u) => (
        <section key={u} className="group">
          {units.length > 1 && <h3 className="group-title">Unit {u}</h3>}
          {zones
            .filter((z) => Math.floor(z.zone / 10) === u)
            .map((z) => (
              <ZoneCard key={z.zone} z={z} onOpen={() => onOpen(z.zone)} />
            ))}
        </section>
      ))}
      {open !== null && <ZoneDetail zone={open} onClose={onClose} />}
    </>
  );
}
