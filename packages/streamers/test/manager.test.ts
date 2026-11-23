import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamerEvent, StreamerLink } from '@open-zone/shared';
import {
  NS,
  StreamerManager,
  type CastClientEvents,
  type CastConnection,
  type NowPlaying,
  type ServiceInstance,
} from '../src/index.ts';

const CCA = '5a683509b32cd1fb5fbabd79315b5ac5';
const GROUP = 'bd05613ae87a462293436c60783d01ac';

class FakeConn extends EventEmitter<CastClientEvents> implements CastConnection {
  closed = false;
  members: string[] = [];
  fail = false;
  readonly host: string;
  readonly port: number;
  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
  }
  async connect() {
    if (this.fail) throw new Error('refused');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  async queryMultizone() {
    return this.members;
  }
  play(np: Partial<NowPlaying> | null) {
    this.emit(
      'nowPlaying',
      np && {
        app: 'YouTube Music',
        state: 'playing',
        title: null,
        artist: null,
        album: null,
        artUrl: null,
        position: 0,
        duration: 200,
        at: Date.now(),
        ...np,
      },
    );
  }
}

const svc = (
  id: string,
  name: string,
  address: string,
  port = 8009,
  md = 'Chromecast Audio',
): ServiceInstance => ({
  instance: `${name}._googlecast._tcp.local`,
  host: `${id}.local`,
  port,
  addresses: [address],
  txt: { id, fn: name, md },
});

function setup(found: ServiceInstance[][]) {
  const conns: FakeConn[] = [];
  let round = 0;
  const events: StreamerEvent[] = [];
  const mgr = new StreamerManager({
    discover: async () => found[Math.min(round++, found.length - 1)]!,
    connect: (host, port) => {
      const c = new FakeConn(host, port);
      if (host === '0.0.0.0') c.fail = true;
      if (port === 32179) c.members = [CCA, 'other'];
      conns.push(c);
      return c;
    },
    searchMs: 20,
    rediscoverMs: 50,
    retryMs: { initial: 20, max: 40 },
    holdMs: 80,
  });
  mgr.on('event', (e) => events.push(e));
  managers.push(mgr);
  const np = () => events.filter((e) => e.type === 'nowPlaying.changed');
  const device = () => conns.find((c) => c.port === 8009 && !c.closed)!;
  return { mgr, conns, events, np, device };
}

const managers: StreamerManager[] = [];
afterEach(() => managers.splice(0).forEach((m) => m.stop()));

const link = (source = 5): StreamerLink => ({
  id: 's1',
  type: 'cast',
  deviceId: CCA,
  name: '5',
  source,
});

describe('StreamerManager', () => {
  it('finds a linked device by id, reports per source, and follows a source change', async () => {
    const { mgr, np, device } = setup([[svc(CCA, '5', '192.168.4.50')]]);
    mgr.setLinks([link(5)]);
    await vi.waitFor(() => expect(mgr.status()[0]?.state).toBe('connected'));
    expect(mgr.status()[0]?.address).toBe('192.168.4.50');
    device().play({ title: 'Song A', artist: 'Band', artUrl: 'https://art/a.jpg' });
    expect(mgr.nowPlaying()).toMatchObject([
      { source: 5, streamerId: 's1', title: 'Song A', group: null },
    ]);
    mgr.setLinks([link(3)]);
    expect(np().at(-2)).toEqual({ type: 'nowPlaying.changed', source: 5, nowPlaying: null });
    expect(np().at(-1)).toMatchObject({ source: 3, nowPlaying: { source: 3, title: 'Song A' } });
    mgr.setLinks([]);
    expect(device()).toBeUndefined(); // closed
    expect(np().at(-1)).toEqual({ type: 'nowPlaying.changed', source: 3, nowPlaying: null });
  });

  it('keeps searching until the device appears, and reconnects at a new address', async () => {
    const { mgr, device } = setup([
      [],
      [svc(CCA, '5', '192.168.4.50')],
      [svc(CCA, '5', '192.168.4.77')],
    ]);
    mgr.setLinks([link()]);
    await vi.waitFor(() => expect(mgr.status()[0]?.state).toBe('searching'));
    await vi.waitFor(() =>
      expect(mgr.status()[0]).toMatchObject({ state: 'connected', address: '192.168.4.50' }),
    );
    device().close(); // device rebooted
    expect(mgr.status()[0]?.state).toBe('offline');
    await vi.waitFor(() =>
      expect(mgr.status()[0]).toMatchObject({ state: 'connected', address: '192.168.4.77' }),
    );
  });

  it('reads track details from the speaker group while the device plays in it', async () => {
    const { mgr, conns, device } = setup([
      [
        svc(CCA, '5', '192.168.4.50'),
        svc(GROUP, 'Full Home', '192.168.4.50', 32179, 'Google Cast Group'),
      ],
    ]);
    mgr.setLinks([link()]);
    await vi.waitFor(() => expect(mgr.status()[0]?.state).toBe('connected'));
    device().play({ title: 'Solo' });
    // Group playback: the device runs an app without a media channel.
    device().emit('receiver', [
      {
        appId: '531A4F84',
        displayName: 'YouTube Music',
        namespaces: [{ name: 'urn:x-cast:com.google.youtube.mdx' }],
      },
    ]);
    const group = await vi.waitFor(() => {
      const g = conns.find((c) => c.port === 32179);
      expect(g).toBeDefined();
      return g!;
    });
    await vi.waitFor(() => expect(mgr.nowPlaying()[0]).toMatchObject({ title: 'Solo' })); // held while joining
    group.play({ title: 'Group Song' });
    await vi.waitFor(() =>
      expect(mgr.nowPlaying()[0]).toMatchObject({
        title: 'Group Song',
        group: 'Full Home',
        source: 5,
      }),
    );
    // Back to playing alone.
    device().emit('receiver', [
      { appId: 'X', displayName: 'YouTube Music', namespaces: [{ name: NS.media }] },
    ]);
    device().play({ title: 'Solo again' });
    expect(mgr.nowPlaying()[0]).toMatchObject({ title: 'Solo again', group: null });
    expect(group.closed).toBe(true);
  });

  it('holds the last track briefly while the next one loads', async () => {
    const { mgr, device, np } = setup([[svc(CCA, '5', '192.168.4.50')]]);
    mgr.setLinks([link()]);
    await vi.waitFor(() => expect(mgr.status()[0]?.state).toBe('connected'));
    device().play({ title: 'Track 1', artist: 'A' });
    device().play({ state: 'buffering' }); // skip: no details for a moment
    expect(mgr.nowPlaying()[0]).toMatchObject({ title: 'Track 1', state: 'buffering' });
    device().play({ title: 'Track 2', artist: 'B' });
    expect(mgr.nowPlaying()[0]).toMatchObject({ title: 'Track 2', state: 'playing' });
    // If nothing arrives, the hold expires.
    device().play({ state: 'buffering' });
    await vi.waitFor(() =>
      expect(mgr.nowPlaying()[0]).toMatchObject({ title: null, state: 'buffering' }),
    );
    // One event per real change: Track 1 playing, then held while buffering.
    expect(
      np()
        .filter((e) => e.nowPlaying?.title === 'Track 1')
        .map((e) => e.nowPlaying?.state),
    ).toEqual(['playing', 'buffering']);
  });

  it('lists discovered devices, groups last', async () => {
    const { mgr } = setup([
      [
        svc(GROUP, 'Full Home', '192.168.4.50', 32179, 'Google Cast Group'),
        svc(CCA, '5', '192.168.4.50'),
      ],
    ]);
    expect((await mgr.findDevices()).map((d) => [d.name, d.isGroup])).toEqual([
      ['5', false],
      ['Full Home', true],
    ]);
  });
});
