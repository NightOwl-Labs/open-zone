/**
 * Read-only Google Cast client: connects to a Cast device (e.g. Chromecast
 * Audio), follows whichever app is casting and reports its media status.
 * It never sends playback commands.
 */
import { EventEmitter } from 'node:events';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { FrameReader, NS, encodeMessage, type CastMessage } from './protocol.ts';

export const CAST_PORT = 8009;
const SENDER = 'sender-oz';
const RECEIVER = 'receiver-0';

export type PlayState = 'playing' | 'paused' | 'buffering' | 'idle';

/** What a streamer is playing, normalized across device types. */
export interface NowPlaying {
  /** App doing the casting, e.g. "Spotify", "YouTube Music". */
  app: string | null;
  state: PlayState;
  title: string | null;
  artist: string | null;
  album: string | null;
  artUrl: string | null;
  /** Seconds into the track when `at` was recorded. */
  position: number | null;
  duration: number | null;
  /** Epoch ms this was observed. */
  at: number;
}

export interface ReceiverApp {
  appId: string;
  displayName?: string;
  statusText?: string;
  sessionId?: string;
  transportId?: string;
  isIdleScreen?: boolean;
  namespaces?: Array<{ name: string }>;
}

interface MediaStatusEntry {
  mediaSessionId?: number;
  playerState?: string;
  currentTime?: number;
  media?: {
    duration?: number;
    metadata?: {
      title?: string;
      artist?: string;
      albumArtist?: string;
      subtitle?: string;
      albumName?: string;
      images?: Array<{ url?: string; width?: number; height?: number }>;
    };
  };
}

export interface CastClientEvents {
  /** Every decoded message, for probes and debugging. */
  message: [direction: 'in' | 'out', message: CastMessage];
  receiver: [apps: ReceiverApp[]];
  nowPlaying: [nowPlaying: NowPlaying | null];
  close: [error?: Error];
}

export class CastClient extends EventEmitter<CastClientEvents> {
  private socket: TLSSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastPong = 0;
  private requestId = 1;
  private transportId: string | null = null;
  private app: ReceiverApp | null = null;
  /** Cast only sends `media` when it changes; keep the last one per session. */
  private lastMedia: MediaStatusEntry['media'] | undefined;
  private lastSession: number | undefined;
  private current: NowPlaying | null = null;

  readonly host: string;
  readonly port: number;

  constructor(host: string, port = CAST_PORT) {
    super();
    this.host = host;
    this.port = port;
  }

  get nowPlaying(): NowPlaying | null {
    return this.current;
  }

  async connect(timeoutMs = 5000): Promise<void> {
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      // Cast devices use self-signed certificates; this is a LAN-only, read-only link.
      const s = tlsConnect({ host: this.host, port: this.port, rejectUnauthorized: false });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`timed out connecting to ${this.host}:${this.port}`));
      }, timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.socket = socket;
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const m of reader.push(chunk)) this.handle(m);
      } catch (err) {
        this.close(err as Error);
      }
    });
    socket.on('error', (err) => this.close(err));
    socket.on('close', () => this.close());

    this.send(RECEIVER, NS.connection, { type: 'CONNECT' });
    this.send(RECEIVER, NS.receiver, { type: 'GET_STATUS', requestId: this.requestId++ });
    this.lastPong = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 16_000) {
        this.close(new Error('heartbeat lost'));
        return;
      }
      this.send(RECEIVER, NS.heartbeat, { type: 'PING' });
    }, 5000);
  }

  /**
   * Member device ids of this endpoint (for a speaker group: every speaker in
   * it; for a single device: itself), lower case without dashes.
   */
  queryMultizone(timeoutMs = 3000): Promise<string[]> {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage);
        reject(new Error('no multizone status'));
      }, timeoutMs);
      const onMessage = (dir: 'in' | 'out', m: CastMessage) => {
        if (dir !== 'in' || m.namespace !== NS.multizone) return;
        let data: {
          requestId?: number;
          type?: string;
          status?: { devices?: Array<{ deviceId?: string }> };
        };
        try {
          data = JSON.parse(m.payload) as typeof data;
        } catch {
          return;
        }
        if (data.requestId !== requestId) return;
        clearTimeout(timer);
        this.off('message', onMessage);
        if (data.type !== 'MULTIZONE_STATUS') return reject(new Error(`multizone: ${data.type}`));
        resolve(
          (data.status?.devices ?? [])
            .map((d) => d.deviceId?.replace(/-/g, '').toLowerCase())
            .filter((d): d is string => !!d),
        );
      };
      this.on('message', onMessage);
      this.send(RECEIVER, NS.multizone, { type: 'GET_STATUS', requestId });
    });
  }

  /** Ask for fresh receiver and media status (they are also pushed on change). */
  refresh(): void {
    this.send(RECEIVER, NS.receiver, { type: 'GET_STATUS', requestId: this.requestId++ });
    if (this.transportId) {
      this.send(this.transportId, NS.media, { type: 'GET_STATUS', requestId: this.requestId++ });
    }
  }

  close(error?: Error): void {
    if (!this.socket) return;
    clearInterval(this.heartbeat);
    const s = this.socket;
    this.socket = undefined;
    try {
      this.send(RECEIVER, NS.connection, { type: 'CLOSE' }, s);
    } catch {
      /* already gone */
    }
    s.destroy();
    this.emit('close', error);
  }

  private send(
    destinationId: string,
    namespace: string,
    payload: object,
    socket = this.socket,
  ): void {
    if (!socket || socket.destroyed) return;
    const message = {
      sourceId: SENDER,
      destinationId,
      namespace,
      payload: JSON.stringify(payload),
    };
    this.emit('message', 'out', message);
    socket.write(encodeMessage(message));
  }

  private handle(m: CastMessage): void {
    this.emit('message', 'in', m);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(m.payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = data.type;
    if (m.namespace === NS.heartbeat) {
      if (type === 'PING') this.send(m.sourceId, NS.heartbeat, { type: 'PONG' });
      this.lastPong = Date.now();
    } else if (m.namespace === NS.connection && type === 'CLOSE') {
      if (m.sourceId === this.transportId) this.followApp(null);
    } else if (m.namespace === NS.receiver && type === 'RECEIVER_STATUS') {
      const status = data.status as { applications?: ReceiverApp[] } | undefined;
      const apps = status?.applications ?? [];
      this.emit('receiver', apps);
      const app =
        apps.find((a) => !a.isIdleScreen && a.namespaces?.some((n) => n.name === NS.media)) ?? null;
      this.followApp(app);
    } else if (m.namespace === NS.media && type === 'MEDIA_STATUS') {
      const entry = (data.status as MediaStatusEntry[] | undefined)?.[0];
      this.applyMedia(entry);
    }
  }

  /** Connect to the casting app's transport so its media status reaches us. */
  private followApp(app: ReceiverApp | null): void {
    const transport = app?.transportId ?? null;
    this.app = app;
    if (transport === this.transportId) return;
    this.transportId = transport;
    this.lastMedia = undefined;
    this.lastSession = undefined;
    if (transport) {
      this.send(transport, NS.connection, { type: 'CONNECT' });
      this.send(transport, NS.media, { type: 'GET_STATUS', requestId: this.requestId++ });
    } else {
      this.setNowPlaying(null);
    }
  }

  private applyMedia(entry: MediaStatusEntry | undefined): void {
    if (!entry) {
      // No media session: the app is open but nothing is loaded.
      this.setNowPlaying(this.app ? this.build(undefined, 'IDLE') : null);
      return;
    }
    if (entry.mediaSessionId !== this.lastSession) {
      this.lastSession = entry.mediaSessionId;
      this.lastMedia = undefined;
    }
    if (entry.media) this.lastMedia = entry.media;
    this.setNowPlaying(this.build(entry, entry.playerState));
  }

  private build(entry: MediaStatusEntry | undefined, playerState: string | undefined): NowPlaying {
    const md = this.lastMedia?.metadata;
    return {
      app: this.app?.displayName ?? null,
      state: toPlayState(playerState),
      title: md?.title ?? null,
      artist: md?.artist ?? md?.albumArtist ?? md?.subtitle ?? null,
      album: md?.albumName ?? null,
      artUrl: largestImage(md?.images),
      position: entry?.currentTime ?? null,
      duration: this.lastMedia?.duration ?? null,
      at: Date.now(),
    };
  }

  private setNowPlaying(np: NowPlaying | null): void {
    this.current = np;
    this.emit('nowPlaying', np);
  }
}

/** The biggest http(s) image (by width when given, else the first). */
function largestImage(images: Array<{ url?: string; width?: number }> | undefined): string | null {
  const usable = (images ?? []).filter((i) => i.url && /^https?:\/\//i.test(i.url));
  if (usable.length === 0) return null;
  return usable.reduce((best, i) => ((i.width ?? 0) > (best.width ?? 0) ? i : best)).url!;
}

/**
 * True when the device is playing as part of a speaker group: an app is
 * running that has no media channel of its own (the group carries it).
 */
export function isGroupFollower(apps: ReceiverApp[]): boolean {
  const active = apps.filter((a) => !a.isIdleScreen);
  return active.length > 0 && !active.some((a) => a.namespaces?.some((n) => n.name === NS.media));
}

function toPlayState(s: string | undefined): PlayState {
  switch (s) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED':
      return 'paused';
    case 'BUFFERING':
      return 'buffering';
    default:
      return 'idle';
  }
}
