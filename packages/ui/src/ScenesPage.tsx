import { useState } from 'react';
import type { Scene, ZoneView } from '@open-zone/shared';
import { api } from './api.ts';
import { Icon, Sheet, Slider, Toggle } from './components.tsx';
import { roleOf, sourceLabel, zoneLabel } from './format.ts';
import { errorText, run, useApp } from './store.ts';

const MAX_VOL = 38;
/** How far Lower all turns every playing zone down (of 38 steps). */
const LOWER_STEPS = 10;

/**
 * Quick actions above the zone list: All off, Mute all and Lower all (each
 * becomes its undo while active), then one button per scene.
 */
export function QuickBar() {
  const scenes = useApp((s) => s.scenes);
  const quiet = useApp((s) => s.system?.quiet);
  const zones = useApp((s) => s.zones);
  const stateOf = (zone: number) => zones.find((z) => z.zone === zone)?.state;
  // Active while at least one zone is still as Mute all / Lower all left it.
  const muted = quiet?.muted.some((z) => stateOf(z)?.mute) ?? false;
  const lowered = quiet?.lowered.some((l) => stateOf(l.zone)?.volume === l.to) ?? false;
  return (
    <div className="quick-bar" role="toolbar" aria-label="Quick actions">
      <button type="button" className="quick all-off" onClick={() => void run(() => api.allOff())}>
        <Icon name="power" />
        All off
      </button>
      <button
        type="button"
        className={`quick quiet${muted ? ' active' : ''}`}
        aria-pressed={muted}
        onClick={() => void run(() => (muted ? api.unmuteAll() : api.muteAll()))}
      >
        <Icon name={muted ? 'speaker' : 'muted'} />
        {muted ? 'Unmute all' : 'Mute all'}
      </button>
      <button
        type="button"
        className={`quick quiet${lowered ? ' active' : ''}`}
        aria-pressed={lowered}
        onClick={() => void run(() => (lowered ? api.restoreVolume() : api.lowerAll(LOWER_STEPS)))}
      >
        <Icon name={lowered ? 'speaker' : 'quieter'} />
        {lowered ? 'Restore volume' : 'Lower all'}
      </button>
      {scenes.map((sc) => (
        <button
          type="button"
          key={sc.id}
          className="quick"
          onClick={() => void run(() => api.activateScene(sc.id))}
        >
          <Icon name="scenes" />
          {sc.name}
        </button>
      ))}
    </div>
  );
}

interface Draft {
  name: string;
  source: number;
  othersOff: boolean;
  zones: Map<number, number>; // zone -> preset volume
}

function SceneEditor({ scene, onClose }: { scene: Scene | null; onClose: () => void }) {
  const zones = useApp((s) => s.zones).filter((z) => z.enabled);
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const enabledSources = sources.filter((s) => s.enabled || s.source === scene?.source);
  const [draft, setDraft] = useState<Draft>(() => ({
    name: scene?.name ?? '',
    source: scene?.source ?? enabledSources[0]?.source ?? 1,
    othersOff: scene?.othersOff ?? false,
    zones: new Map(scene?.zones.map((z) => [z.zone, z.volume]) ?? []),
  }));
  const [allVolume, setAllVolume] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const followsReason = (z: ZoneView): string | null => {
    const role = roleOf(z.zone, mirrors);
    if (role?.kind !== 'follower' || !role.group.enabled) return null;
    const primary = zones.find((x) => x.zone === role.group.primary);
    return `follows ${primary ? zoneLabel(primary) : 'its primary'}`;
  };
  const setZones = (fn: (m: Map<number, number>) => void) =>
    setDraft((d) => {
      const m = new Map(d.zones);
      fn(m);
      return { ...d, zones: m };
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = {
        name: draft.name.trim(),
        source: draft.source,
        othersOff: draft.othersOff,
        zones: [...draft.zones].map(([zone, volume]) => ({ zone, volume })),
      };
      if (scene) await api.updateScene(scene.id, input);
      else await api.createScene(input);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={scene ? 'Edit scene' : 'New scene'} onClose={onClose}>
      <div className="field">
        <span>Name</span>
        <input
          className="text"
          value={draft.name}
          maxLength={40}
          placeholder="e.g. Dinner, Movie night"
          onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
        />
      </div>
      <div className="field">
        <span>Source for every zone</span>
        <select
          className="select"
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: Number(e.currentTarget.value) })}
        >
          {enabledSources.map((s) => (
            <option key={s.source} value={s.source}>
              {sourceLabel(sources, s.source)}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <span>Turn off all other zones</span>
        <Toggle
          label="Turn off all other zones"
          checked={draft.othersOff}
          onChange={(othersOff) => setDraft({ ...draft, othersOff })}
        />
      </div>
      <div className="field">
        <span>Zones and their volumes</span>
        <p className="muted-text small">
          Each zone keeps its own preset volume, since speakers differ (stereo vs mono, 4 vs 8 ohm).
          Use &ldquo;Set all&rdquo; to start everyone at the same level, then fine-tune.
        </p>
        <div className="set-all">
          <Slider
            label="Volume for all selected zones"
            value={allVolume}
            min={0}
            max={MAX_VOL}
            onCommit={setAllVolume}
          />
          <button
            type="button"
            className="btn"
            disabled={draft.zones.size === 0}
            onClick={() => setZones((m) => m.forEach((_, k) => m.set(k, allVolume)))}
          >
            Set all
          </button>
        </div>
        <ul className="check-list scene-zones">
          {zones.map((z) => {
            const reason = followsReason(z);
            const volume = draft.zones.get(z.zone);
            const checked = volume !== undefined;
            return (
              <li key={z.zone} className={checked ? 'checked' : ''}>
                <label className={reason && !checked ? 'disabled' : ''}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!!reason && !checked}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setZones((m) =>
                        on ? m.set(z.zone, z.state?.volume ?? allVolume) : m.delete(z.zone),
                      );
                    }}
                  />
                  <span>{zoneLabel(z)}</span>
                  {reason && <span className="tag">{reason}</span>}
                </label>
                {checked && (
                  <div className="scene-volume">
                    <Slider
                      label={`${zoneLabel(z)} preset volume`}
                      value={volume}
                      min={0}
                      max={MAX_VOL}
                      onCommit={(v) => setZones((m) => m.set(z.zone, v))}
                    />
                  </div>
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
        disabled={saving || !draft.name.trim() || draft.zones.size === 0}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : scene ? 'Save scene' : 'Create scene'}
      </button>
    </Sheet>
  );
}

function SceneCard({ scene, onEdit }: { scene: Scene; onEdit: () => void }) {
  const zones = useApp((s) => s.zones);
  const sources = useApp((s) => s.sources);
  const name = (zone: number) => {
    const z = zones.find((x) => x.zone === zone);
    return z ? zoneLabel(z) : `Zone ${zone}`;
  };
  return (
    <article className="card scene">
      <div className="zone-head">
        <button type="button" className="zone-title" onClick={onEdit}>
          <span className="name">{scene.name}</span>
          <span className="sub">
            {sourceLabel(sources, scene.source)} · {scene.zones.length}{' '}
            {scene.zones.length === 1 ? 'zone' : 'zones'}
            {scene.othersOff ? ' · others off' : ''}
          </span>
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => void run(() => api.activateScene(scene.id))}
        >
          Play
        </button>
      </div>
      <ul className="chips">
        {scene.zones.map((z) => (
          <li key={z.zone} className="chip">
            {name(z.zone)} <b>{z.volume}</b>
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
            if (window.confirm(`Delete the scene "${scene.name}"?`)) {
              void run(() => api.deleteScene(scene.id));
            }
          }}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

export function ScenesPage() {
  const scenes = useApp((s) => s.scenes);
  const [editing, setEditing] = useState<Scene | 'new' | null>(null);
  return (
    <>
      <p className="intro">
        A scene sets a group of zones to one source, each at its own volume, in one tap. Scenes also
        appear at the top of the Zones screen next to All off.
      </p>
      {scenes.map((sc) => (
        <SceneCard key={sc.id} scene={sc} onEdit={() => setEditing(sc)} />
      ))}
      <button type="button" className="btn primary block" onClick={() => setEditing('new')}>
        <Icon name="plus" /> New scene
      </button>
      {editing && (
        <SceneEditor scene={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
