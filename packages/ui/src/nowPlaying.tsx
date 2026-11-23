import type { NowPlayingView, ZoneView } from '@open-zone/shared';
import { Icon } from './components.tsx';
import { useApp } from './store.ts';

/**
 * What a zone is hearing: the now-playing info of the streamer linked to the
 * zone's source, while the zone is on. Null when nothing useful is known.
 */
export function useNowPlaying(z: ZoneView): NowPlayingView | null {
  const np = useApp((s) => (z.state?.power ? s.nowPlaying[z.state.source] : undefined));
  if (!np) return null;
  if (!np.title && np.state === 'idle') return null;
  return np;
}

/** A CSS background-image value for cover art, or null for anything but http(s). */
export function artBackground(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // The URL serializer percent-encodes quotes, so this can't break out of url("…").
    return `url("${u.href}")`;
  } catch {
    return null;
  }
}

function headline(np: NowPlayingView): string {
  return np.title ?? (np.state === 'buffering' ? 'Loading…' : (np.app ?? 'Playing'));
}

/** One line: "♪ Title · Artist" (or "Paused · Title"). */
export function NowPlayingLine({ np, className = '' }: { np: NowPlayingView; className?: string }) {
  return (
    <span className={`np-line ${className}`}>
      <Icon name="music" />
      <span className="np-text">
        {np.state === 'paused' ? 'Paused · ' : ''}
        {headline(np)}
        {np.artist ? ` · ${np.artist}` : ''}
      </span>
    </span>
  );
}

const STATE_LABEL: Record<NowPlayingView['state'], string> = {
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Loading',
  idle: 'Stopped',
};

/** Cover art, title, artist and album for a zone's detail sheet. */
export function NowPlayingCard({ np }: { np: NowPlayingView }) {
  const art = np.artUrl && artBackground(np.artUrl) ? np.artUrl : null;
  return (
    <div className="np-card" aria-label="Now playing">
      {art ? (
        <img className="np-art" src={art} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span className="np-art empty" aria-hidden>
          <Icon name="music" />
        </span>
      )}
      <div className="np-info">
        <b className="np-title">{headline(np)}</b>
        {np.artist && <span>{np.artist}</span>}
        {np.album && <span className="muted-text small">{np.album}</span>}
        <span className="np-meta muted-text small">
          {STATE_LABEL[np.state]}
          {np.app ? ` · ${np.app}` : ''}
          {np.group ? ` · in ${np.group}` : ''}
        </span>
      </div>
    </div>
  );
}
