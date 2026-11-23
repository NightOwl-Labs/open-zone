import { useState } from 'react';
import type { DiscoveredStreamer, SourceView, StreamerStatusView } from '@open-zone/shared';
import { api } from './api.ts';
import { errorText, run, toast, useApp } from './store.ts';
import { sourceLabel } from './format.ts';

function statusText(st: StreamerStatusView | undefined): string {
  if (!st) return 'Starting…';
  switch (st.state) {
    case 'connected':
      return `Connected${st.address ? ` at ${st.address}` : ''}`;
    case 'connecting':
      return 'Connecting…';
    case 'searching':
      return 'Looking for it on the network…';
    case 'offline':
      return `Offline${st.error ? `: ${st.error}` : ''}`;
  }
}

function SourceSelect({
  sources,
  value,
  taken,
  onChange,
  label,
}: {
  sources: SourceView[];
  value: number;
  /** Sources already linked to another streamer. */
  taken: Set<number>;
  onChange: (source: number) => void;
  label: string;
}) {
  return (
    <select
      className="select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
    >
      {sources.map((s) => (
        <option
          key={s.source}
          value={s.source}
          disabled={taken.has(s.source) && s.source !== value}
        >
          {sourceLabel(sources, s.source)}
          {taken.has(s.source) && s.source !== value ? ' (linked)' : ''}
        </option>
      ))}
    </select>
  );
}

/**
 * Settings → Streamers: link a network streamer (Chromecast Audio for now) to
 * an amp source, so zones on that source show what it is playing.
 */
export function StreamersSettings() {
  const { links, status, enabled } = useApp((s) => s.streamers);
  const sources = useApp((s) => s.sources);
  const [found, setFound] = useState<DiscoveredStreamer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picks, setPicks] = useState<Record<string, number>>({});

  const taken = new Set(links.map((l) => l.source));
  const linkedIds = new Set(links.map((l) => l.deviceId));
  const firstFree = sources.find((s) => !taken.has(s.source))?.source ?? null;

  const find = async () => {
    setSearching(true);
    try {
      setFound(await api.discoverStreamers());
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setSearching(false);
    }
  };

  const devices = found?.filter((d) => !d.isGroup && !linkedIds.has(d.deviceId)) ?? [];
  const groups = found?.filter((d) => d.isGroup) ?? [];

  return (
    <section className="card">
      <div className="card-head">
        <h3>Streamers</h3>
      </div>
      <p className="muted-text small">
        Link a Chromecast Audio (or other Cast device) to the amp source it&apos;s plugged into.
        Zones on that source then show the song and cover art. open-zone only reads what&apos;s
        playing; it never controls the streamer.
      </p>
      {!enabled && (
        <p className="note">
          The server was started with streamers turned off (<code>--no-streamers</code>), so links
          are saved but not followed.
        </p>
      )}
      {links.length > 0 && (
        <ul className="streamer-list">
          {links.map((l) => {
            const st = status.find((x) => x.id === l.id);
            return (
              <li key={l.id}>
                <div className="streamer-head">
                  <span className={`dot ${st?.state ?? 'searching'}`} aria-hidden />
                  <span className="streamer-name">
                    <b>{l.name}</b>
                    <span className="muted-text small">{statusText(st)}</span>
                  </span>
                </div>
                <div className="streamer-actions">
                  <SourceSelect
                    sources={sources}
                    value={l.source}
                    taken={taken}
                    label={`${l.name} source`}
                    onChange={(source) => void run(() => api.updateStreamer(l.id, { source }))}
                  />
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => void run(() => api.unlinkStreamer(l.id), `${l.name} unlinked`)}
                  >
                    Unlink
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="btn block" disabled={searching} onClick={() => void find()}>
        {searching ? 'Looking on the network…' : 'Find streamers'}
      </button>
      {found && (
        <>
          {devices.length === 0 ? (
            <p className="muted-text small">
              {found.length === 0
                ? 'No Cast devices answered. The server must be on the same network as the streamers.'
                : 'Every Cast device found is already linked.'}
            </p>
          ) : (
            <ul className="streamer-list">
              {devices.map((d) => {
                const pick = picks[d.deviceId] ?? firstFree;
                return (
                  <li key={d.deviceId}>
                    <div className="streamer-head">
                      <span className="streamer-name">
                        <b>{d.name}</b>
                        <span className="muted-text small">
                          {[d.model, d.address].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </div>
                    <div className="streamer-actions">
                      {pick === null ? (
                        <span className="muted-text small">Every source is linked already.</span>
                      ) : (
                        <>
                          <SourceSelect
                            sources={sources}
                            value={pick}
                            taken={taken}
                            label={`Source for ${d.name}`}
                            onChange={(source) => setPicks((p) => ({ ...p, [d.deviceId]: source }))}
                          />
                          <button
                            type="button"
                            className="btn primary"
                            onClick={() =>
                              void run(
                                () =>
                                  api.linkStreamer({
                                    type: 'cast',
                                    deviceId: d.deviceId,
                                    name: d.name.slice(0, 40),
                                    source: pick,
                                  }),
                                `${d.name} linked to ${sourceLabel(sources, pick)}`,
                              )
                            }
                          >
                            Link
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {groups.length > 0 && (
            <p className="muted-text small">
              Speaker groups found ({groups.map((g) => g.name).join(', ')}) can&apos;t be linked
              themselves. When a linked device plays in a group, the group&apos;s song is shown
              automatically.
            </p>
          )}
        </>
      )}
    </section>
  );
}
