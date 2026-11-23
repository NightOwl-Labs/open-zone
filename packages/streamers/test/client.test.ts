import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CastClient, FrameReader, NS, encodeMessage, type NowPlaying } from '../src/index.ts';

/** A self-signed cert for the fake device (Cast devices also use self-signed certs). */
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'oz-cast-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=fake-cast',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

/** Minimal fake Chromecast: answers status requests the way a casting app does. */
async function fakeDevice() {
  let socket: TLSSocket | undefined;
  const send = (src: string, ns: string, payload: object) =>
    socket?.write(
      encodeMessage({
        sourceId: src,
        destinationId: '*',
        namespace: ns,
        payload: JSON.stringify(payload),
      }),
    );
  const server = createServer(selfSigned(), (s) => {
    socket = s;
    const reader = new FrameReader();
    s.on('data', (chunk: Buffer) => {
      for (const m of reader.push(chunk)) {
        const p = JSON.parse(m.payload) as { type: string };
        if (m.namespace === NS.receiver && p.type === 'GET_STATUS') {
          send('receiver-0', NS.receiver, {
            type: 'RECEIVER_STATUS',
            status: {
              applications: [
                {
                  appId: 'X',
                  displayName: 'Spotify',
                  transportId: 't-1',
                  namespaces: [{ name: NS.media }],
                },
              ],
            },
          });
        } else if (m.namespace === NS.media && p.type === 'GET_STATUS') {
          send('t-1', NS.media, {
            type: 'MEDIA_STATUS',
            status: [
              {
                mediaSessionId: 1,
                playerState: 'PLAYING',
                currentTime: 12,
                media: {
                  duration: 200,
                  metadata: {
                    title: 'Song A',
                    artist: 'Band',
                    albumName: 'LP',
                    images: [{ url: 'http://art/a.jpg' }],
                  },
                },
              },
            ],
          });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, send, close: () => server.close() };
}

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

describe('CastClient', () => {
  it('follows the casting app and reports now playing, keeping metadata across updates', async () => {
    const dev = await fakeDevice();
    const client = new CastClient('127.0.0.1', dev.port);
    cleanup.push(
      () => client.close(),
      () => dev.close(),
    );
    const seen: Array<NowPlaying | null> = [];
    client.on('nowPlaying', (np) => seen.push(np));
    await client.connect();
    await vi.waitFor(() => expect(client.nowPlaying?.title).toBe('Song A'));
    expect(client.nowPlaying).toMatchObject({
      app: 'Spotify',
      state: 'playing',
      artist: 'Band',
      album: 'LP',
      artUrl: 'http://art/a.jpg',
      position: 12,
      duration: 200,
    });
    // A pause update without `media` keeps the track details.
    dev.send('t-1', NS.media, {
      type: 'MEDIA_STATUS',
      status: [{ mediaSessionId: 1, playerState: 'PAUSED', currentTime: 30 }],
    });
    await vi.waitFor(() => expect(client.nowPlaying?.state).toBe('paused'));
    expect(client.nowPlaying).toMatchObject({ title: 'Song A', position: 30 });
    // The app quits: nothing is playing.
    dev.send('receiver-0', NS.receiver, { type: 'RECEIVER_STATUS', status: { applications: [] } });
    await vi.waitFor(() => expect(client.nowPlaying).toBeNull());
  });
});
