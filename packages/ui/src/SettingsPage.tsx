import { useEffect, useState } from 'react';
import type { PollingConfig } from '@open-zone/shared';
import { api } from './api.ts';
import { Icon, NameInput, StatusPill, Toggle } from './components.tsx';
import { sourceLabel, zoneLabel } from './format.ts';
import { run, toast, useApp } from './store.ts';

function Connection() {
  const system = useApp((s) => s.system);
  if (!system) return null;
  const q = system.queue;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Amplifier</h3>
        <StatusPill />
      </div>
      <dl className="facts">
        <dt>Model</dt>
        <dd>{system.model.displayName}</dd>
        <dt>Link</dt>
        <dd>{system.connection.transport || '—'}</dd>
        <dt>Units</dt>
        <dd>{system.units.length ? system.units.join(', ') : '—'}</dd>
        <dt>Command time</dt>
        <dd>
          {q.avgMs !== null ? `${q.avgMs} ms avg · ${q.maxMs} ms max` : '—'}
          {q.failed ? ` · ${q.failed} failed` : ''}
        </dd>
        <dt>Polling</dt>
        <dd>
          {system.polling.mirrorActive ? 'mirror primaries' : 'no mirrors'} ·{' '}
          {system.polling.interactiveClients} open{' '}
          {system.polling.interactiveClients === 1 ? 'screen' : 'screens'}
        </dd>
        {system.connection.error && (
          <>
            <dt>Last error</dt>
            <dd>{system.connection.error}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Simulator() {
  const zones = useApp((s) => s.zones);
  const sources = useApp((s) => s.sources);
  const [zone, setZone] = useState<number | null>(null);
  const z = zones.find((x) => x.zone === zone) ?? zones[0];
  if (!z) return null;
  const s = z.state;
  const press = (body: Parameters<typeof api.simulateKeypad>[1]) =>
    void run(() => api.simulateKeypad(z.zone, body));
  return (
    <section className="card sim">
      <div className="card-head">
        <h3>
          <Icon name="keypad" /> Simulated keypad
        </h3>
      </div>
      <p className="muted-text small">
        Acts like someone at a wall keypad: the change happens on the emulated amp, and open-zone
        finds it by polling, just as it will with real hardware. Use it on a mirror primary to see
        its zones follow.
      </p>
      <select
        className="select"
        aria-label="Keypad zone"
        value={z.zone}
        onChange={(e) => setZone(Number(e.currentTarget.value))}
      >
        {zones.map((x) => (
          <option key={x.zone} value={x.zone}>
            {zoneLabel(x)}
          </option>
        ))}
      </select>
      {s && (
        <>
          <div className="keypad">
            <button
              type="button"
              className="btn"
              onClick={() => press({ patch: { power: !s.power } })}
            >
              Power {s.power ? 'off' : 'on'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => press({ patch: { volume: Math.max(0, s.volume - 2) } })}
            >
              Vol −
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => press({ patch: { volume: Math.min(38, s.volume + 2) } })}
            >
              Vol +
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => press({ patch: { source: (s.source % sources.length) + 1 } })}
            >
              Next source
            </button>
          </div>
          <p className="muted-text small">
            Now: {s.power ? 'on' : 'off'} · {sourceLabel(sources, s.source)} · volume {s.volume}
          </p>
          <div className="field-row">
            <span>Keypad connected</span>
            <Toggle
              label="Keypad connected"
              checked={s.keypad}
              onChange={(keypad) => press({ keypad })}
            />
          </div>
        </>
      )}
    </section>
  );
}

function Names() {
  const zones = useApp((s) => s.zones);
  const sources = useApp((s) => s.sources);
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3>Sources</h3>
        </div>
        <p className="muted-text small">
          The amp can&apos;t tell which inputs have something plugged in. Turn off unused sources to
          hide them from the zone source lists.
        </p>
        <ul className="name-list">
          {sources.map((s) => (
            <li key={s.source} className={s.enabled ? '' : 'off'}>
              <span className="idx">{s.source}</span>
              <NameInput
                label={`Source ${s.source} name`}
                value={s.name}
                placeholder={sourceLabel([], s.source)}
                onSave={(name) => void run(() => api.updateSource(s.source, { name }))}
              />
              <Toggle
                label={`Source ${s.source} enabled`}
                checked={s.enabled}
                onChange={(enabled) => void run(() => api.updateSource(s.source, { enabled }))}
              />
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Zones</h3>
        </div>
        <ul className="name-list">
          {zones.map((z) => (
            <li key={z.zone}>
              <span className="idx">{z.zone}</span>
              <NameInput
                label={`Zone ${z.zone} name`}
                value={z.name}
                placeholder={`Zone ${z.zone}`}
                onSave={(name) => void run(() => api.renameZone(z.zone, name))}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Polling() {
  const config = useApp((s) => s.config);
  const [form, setForm] = useState<PollingConfig | null>(config?.polling ?? null);
  useEffect(() => setForm(config?.polling ?? null), [config]);
  if (!form) return null;
  const fields: Array<[keyof PollingConfig, string, string]> = [
    [
      'mirrorPrimaryMs',
      'Mirror primary poll',
      'How quickly keypad changes on a primary zone reach its followers',
    ],
    [
      'mirrorFollowerAuditMs',
      'Mirror check cycle',
      'How often every following zone is double-checked',
    ],
    ['interactiveMs', 'Screen refresh', 'How often all zones are read while this app is open'],
  ];
  return (
    <section className="card">
      <div className="card-head">
        <h3>Polling</h3>
      </div>
      {fields.map(([key, label, help]) => (
        <label key={key} className="field">
          <span>{label}</span>
          <span className="muted-text small">{help}</span>
          <span className="with-unit">
            <input
              className="text"
              type="number"
              inputMode="numeric"
              min={100}
              step={50}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: Number(e.currentTarget.value) })}
            />
            <span>ms</span>
          </span>
        </label>
      ))}
      <button
        type="button"
        className="btn primary"
        onClick={() =>
          void run(async () => {
            await api.updatePolling(form);
            toast('Polling settings saved');
          })
        }
      >
        Save polling
      </button>
    </section>
  );
}

export function SettingsPage() {
  const simulator = useApp((s) => s.system?.simulator);
  return (
    <>
      <Connection />
      {simulator && <Simulator />}
      <Names />
      <Polling />
    </>
  );
}
