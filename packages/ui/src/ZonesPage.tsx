import type { SourceView, ZonePatch, ZoneView } from '@open-zone/shared';
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
import { getState, run, setZone, useApp } from './store.ts';
import { api } from './api.ts';

/**
 * Changing anything but volume on a mirror child detaches it from the
 * mirror. Ask first so it never happens by accident.
 */
function change(z: ZoneView, role: Role, patch: ZonePatch): void {
  const breaks = role?.kind === 'child' && Object.keys(patch).some((k) => k !== 'volume');
  if (breaks) {
    const master = getState().zones.find((x) => x.zone === role.group.master);
    const ok = window.confirm(
      `${zoneLabel(z)} follows ${master ? zoneLabel(master) : 'its master'}. ` +
        `Changing this will remove it from the mirror. Continue?`,
    );
    if (!ok) return;
  }
  void setZone(z.zone, patch);
}

function RoleBadge({ role, zones }: { role: Role; zones: ZoneView[] }) {
  if (!role) return null;
  if (role.kind === 'master') {
    const n = role.group.children.length;
    return (
      <span className={`badge master${role.group.enabled ? '' : ' paused'}`}>
        <Icon name="link" />
        {groupLabel(role.group, zones)} · {n} {n === 1 ? 'zone' : 'zones'}
        {role.group.enabled ? '' : ' · paused'}
      </span>
    );
  }
  const master = zones.find((z) => z.zone === role.group.master);
  return (
    <span className={`badge child${role.group.enabled ? '' : ' paused'}`}>
      <Icon name="link" />
      Follows {master ? zoneLabel(master) : `Zone ${role.group.master}`}
      {role.volumeOffset ? ` ${offsetLabel(role.volumeOffset)}` : ''}
    </span>
  );
}

function SourceSelect({ z, role, sources }: { z: ZoneView; role: Role; sources: SourceView[] }) {
  if (!z.state) return null;
  return (
    <select
      className="select"
      aria-label={`${zoneLabel(z)} source`}
      value={z.state.source}
      onChange={(e) => change(z, role, { source: Number(e.currentTarget.value) })}
    >
      {sources.map((s) => (
        <option key={s.source} value={s.source}>
          {sourceLabel(sources, s.source)}
        </option>
      ))}
    </select>
  );
}

function VolumeRow({ z, role }: { z: ZoneView; role: Role }) {
  if (!z.state) return null;
  const s = z.state;
  return (
    <div className="vol-row">
      <button
        type="button"
        className={`icon-btn${s.mute ? ' active' : ''}`}
        aria-label={s.mute ? 'Unmute' : 'Mute'}
        aria-pressed={s.mute}
        onClick={() => change(z, role, { mute: !s.mute })}
      >
        <Icon name={s.mute ? 'muted' : 'speaker'} />
      </button>
      <Slider
        label={`${zoneLabel(z)} volume`}
        value={s.volume}
        min={0}
        max={38}
        onCommit={(v) => change(z, role, { volume: v })}
      />
    </div>
  );
}

function ZoneCard({ z, onOpen }: { z: ZoneView; onOpen: () => void }) {
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  const on = z.state?.power ?? false;
  return (
    <article className={`card zone${on ? ' on' : ''}${z.state?.mute ? ' muted' : ''}`}>
      <div className="zone-head">
        <button type="button" className="zone-title" onClick={onOpen}>
          <span className="name">{zoneLabel(z)}</span>
          <span className="sub">
            {z.state ? (on ? sourceLabel(sources, z.state.source) : 'Off') : 'Not read yet'}
          </span>
          <RoleBadge role={role} zones={zones} />
        </button>
        {z.state && (
          <Toggle
            label={`${zoneLabel(z)} power`}
            checked={on}
            onChange={(v) => change(z, role, { power: v })}
          />
        )}
      </div>
      {on && (
        <div className="zone-body">
          <SourceSelect z={z} role={role} sources={sources} />
          <VolumeRow z={z} role={role} />
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
  const s = z.state;
  return (
    <Sheet title={zoneLabel(z)} onClose={onClose}>
      {role && (
        <p className="note">
          <RoleBadge role={role} zones={zones} />
          {role.kind === 'child' && (
            <>
              <br />
              Volume changes here set this zone&apos;s offset from the master. Any other change
              removes it from the mirror.
            </>
          )}
        </p>
      )}
      {!s ? (
        <p className="muted-text">This zone hasn&apos;t been read from the amp yet.</p>
      ) : (
        <>
          <div className="field-row">
            <span>Power</span>
            <Toggle
              label="Power"
              checked={s.power}
              onChange={(v) => change(z, role, { power: v })}
            />
          </div>
          <div className="field">
            <span>Source</span>
            <SourceSelect z={z} role={role} sources={sources} />
          </div>
          <div className="field">
            <span>Volume</span>
            <VolumeRow z={z} role={role} />
          </div>
          <div className="field">
            <span>Treble</span>
            <Slider
              label="Treble"
              value={s.treble}
              min={0}
              max={14}
              format={(v) => toneLabel(v)}
              onCommit={(v) => change(z, role, { treble: v })}
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
              onCommit={(v) => change(z, role, { bass: v })}
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
              onCommit={(v) => change(z, role, { balance: v })}
            />
          </div>
          <div className="field-row">
            <span>Do not disturb</span>
            <Toggle
              label="Do not disturb"
              checked={s.dnd}
              onChange={(v) => change(z, role, { dnd: v })}
            />
          </div>
        </>
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
