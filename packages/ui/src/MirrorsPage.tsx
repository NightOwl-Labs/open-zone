import { useState } from 'react';
import type { MirrorGroup, ZoneView } from '@open-zone/shared';
import { api } from './api.ts';
import { Icon, Sheet, Toggle } from './components.tsx';
import { groupLabel, offsetLabel, zoneLabel } from './format.ts';
import { errorText, run, useApp } from './store.ts';

interface Follower {
  zone: number;
  volumeOffset: number;
}

const MAX_OFFSET = 38;

function OffsetStepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const set = (v: number) => onChange(Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, v)));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="icon-btn"
        aria-label="Quieter"
        onClick={() => set(value - 1)}
      >
        −
      </button>
      <output aria-live="polite">
        {value === 0 ? 'Same volume' : `${offsetLabel(value)} volume`}
      </output>
      <button type="button" className="icon-btn" aria-label="Louder" onClick={() => set(value + 1)}>
        +
      </button>
    </div>
  );
}

function MirrorEditor({ group, onClose }: { group: MirrorGroup | null; onClose: () => void }) {
  const zones = useApp((s) => s.zones);
  const mirrors = useApp((s) => s.mirrors);
  const [name, setName] = useState(group?.name ?? '');
  const [primary, setPrimary] = useState<number | null>(group?.primary ?? null);
  const [followers, setFollowers] = useState<Follower[]>(
    group?.followers.map((c) => ({ zone: c.zone, volumeOffset: c.volumeOffset })) ?? [],
  );
  const setOffset = (zone: number, volumeOffset: number) =>
    setFollowers((cs) => cs.map((c) => (c.zone === zone ? { ...c, volumeOffset } : c)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** Which group (other than the one being edited) a zone already belongs to. */
  const takenBy = (zone: number) =>
    mirrors.find(
      (g) => g.id !== group?.id && (g.primary === zone || g.followers.some((c) => c.zone === zone)),
    );

  // Zones turned off in Settings can't take part in mirrors.
  const usable = zones.filter((z) => z.enabled);
  const primaryOptions = usable.filter((z) => !takenBy(z.zone));
  const followerReason = (z: ZoneView): string | null => {
    if (z.zone === primary) return 'primary';
    const g = takenBy(z.zone);
    if (g) return `in ${groupLabel(g, zones)}`;
    if (z.state?.keypad) return 'has keypad';
    return null;
  };

  const save = async () => {
    if (primary === null || followers.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const input = { name: name.trim(), primary, followers };
      if (group) await api.updateMirror(group.id, input);
      else await api.createMirror({ ...input, enabled: true });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={group ? 'Edit mirror' : 'New mirror'} onClose={onClose}>
      <div className="field">
        <span>Name (optional)</span>
        <input
          className="text"
          value={name}
          maxLength={40}
          placeholder="e.g. Downstairs"
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </div>
      <div className="field">
        <span>Primary zone — the zone everyone follows</span>
        <select
          className="select"
          value={primary ?? ''}
          onChange={(e) => {
            const m = Number(e.currentTarget.value);
            setPrimary(m);
            setFollowers((cs) => cs.filter((c) => c.zone !== m));
          }}
        >
          <option value="" disabled>
            Choose a zone…
          </option>
          {primaryOptions.map((z) => (
            <option key={z.zone} value={z.zone}>
              {zoneLabel(z)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Zones that follow it</span>
        <p className="muted-text small">
          Zones with a wall keypad can&apos;t follow another zone, since local changes would fight
          the mirror. Use the offset to play a zone louder or quieter than the primary (e.g. −4 for
          a bedroom).
        </p>
        <ul className="check-list">
          {usable.map((z) => {
            const reason = followerReason(z);
            const follower = followers.find((c) => c.zone === z.zone);
            const checked = follower !== undefined;
            return (
              <li key={z.zone} className={checked ? 'checked' : ''}>
                <label className={reason && !checked ? 'disabled' : ''}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!!reason && !checked}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setFollowers((cs) =>
                        on
                          ? [...cs, { zone: z.zone, volumeOffset: 0 }]
                          : cs.filter((c) => c.zone !== z.zone),
                      );
                    }}
                  />
                  <span>{zoneLabel(z)}</span>
                  {reason && <span className="tag">{reason}</span>}
                </label>
                {follower && (
                  <OffsetStepper
                    label={`${zoneLabel(z)} volume offset`}
                    value={follower.volumeOffset}
                    onChange={(v) => setOffset(z.zone, v)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {error && <p className="error-text">{error}</p>}
      <button
        type="button"
        className="btn primary block"
        disabled={primary === null || followers.length === 0 || saving}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : group ? 'Save mirror' : 'Create mirror'}
      </button>
    </Sheet>
  );
}

function GroupCard({ g, onEdit }: { g: MirrorGroup; onEdit: () => void }) {
  const zones = useApp((s) => s.zones);
  const name = (zone: number) => {
    const z = zones.find((x) => x.zone === zone);
    return z ? zoneLabel(z) : `Zone ${zone}`;
  };
  return (
    <article className={`card mirror${g.enabled ? '' : ' paused'}`}>
      <div className="zone-head">
        <button type="button" className="zone-title" onClick={onEdit}>
          <span className="name">{groupLabel(g, zones)}</span>
          <span className="sub">
            {name(g.primary)} leads · {g.enabled ? 'active' : 'paused'}
          </span>
        </button>
        <Toggle
          label={`${groupLabel(g, zones)} enabled`}
          checked={g.enabled}
          onChange={(enabled) => void run(() => api.updateMirror(g.id, { enabled }))}
        />
      </div>
      <ul className="chips">
        {g.followers.length === 0 && (
          <li className="muted-text">No zones follow this primary zone yet.</li>
        )}
        {g.followers.map((c) => (
          <li key={c.zone} className="chip">
            {name(c.zone)}
            {c.volumeOffset ? <b> {offsetLabel(c.volumeOffset)}</b> : null}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (
              window.confirm(`Delete ${groupLabel(g, zones)}? Zones keep their current settings.`)
            ) {
              void run(() => api.deleteMirror(g.id));
            }
          }}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

export function MirrorsPage() {
  const mirrors = useApp((s) => s.mirrors);
  const [editing, setEditing] = useState<MirrorGroup | 'new' | null>(null);
  return (
    <>
      <p className="intro">
        A mirror makes zones follow a primary: power, source, volume, tone and mute. Change the
        primary here or on its keypad and the others follow within about half a second.
      </p>
      {mirrors.map((g) => (
        <GroupCard key={g.id} g={g} onEdit={() => setEditing(g)} />
      ))}
      <button type="button" className="btn primary block" onClick={() => setEditing('new')}>
        <Icon name="plus" /> New mirror
      </button>
      {editing && (
        <MirrorEditor group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
