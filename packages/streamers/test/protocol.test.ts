import { describe, expect, it } from 'vitest';
import {
  FrameReader,
  NS,
  collectInstances,
  decodeRecords,
  encodeMessage,
  encodeQuery,
} from '../src/index.ts';

describe('cast protocol', () => {
  it('round-trips messages through the length-prefixed framing, split anywhere', () => {
    const a = {
      sourceId: 's',
      destinationId: 'receiver-0',
      namespace: NS.receiver,
      payload: '{"type":"GET_STATUS"}',
    };
    const b = { ...a, payload: JSON.stringify({ type: 'X', text: 'é'.repeat(300) }) }; // multi-byte varint
    const wire = Buffer.concat([encodeMessage(a), encodeMessage(b)]);
    const reader = new FrameReader();
    const out = [...reader.push(wire.subarray(0, 7)), ...reader.push(wire.subarray(7))];
    expect(out).toEqual([a, b]);
  });
});

/** Build an mDNS response the way a Chromecast answers a PTR query. */
function response(): Buffer {
  const name = (s: string) =>
    Buffer.concat([
      ...s.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
      Buffer.from([0]),
    ]);
  const rr = (n: Buffer, type: number, rdata: Buffer) => {
    const h = Buffer.alloc(10);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(1, 2);
    h.writeUInt32BE(120, 4);
    h.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([n, h, rdata]);
  };
  const svc = '_googlecast._tcp.local';
  const inst = `Chromecast-Audio-abc.${svc}`;
  const host = 'abc.local';
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(8009, 4);
  const txt = Buffer.concat(
    ['fn=Living Room Speaker', 'md=Chromecast Audio', 'id=abc'].map((s) =>
      Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]),
    ),
  );
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(3, 10);
  return Buffer.concat([
    header,
    rr(name(svc), 12, name(inst)),
    rr(name(inst), 33, Buffer.concat([srv, name(host)])),
    rr(name(inst), 16, txt),
    rr(name(host), 1, Buffer.from([192, 168, 1, 42])),
  ]);
}

describe('mdns', () => {
  it('encodes a PTR query', () => {
    const q = encodeQuery('_googlecast._tcp.local');
    expect(q.readUInt16BE(4)).toBe(1);
    expect(q.subarray(12).toString('latin1')).toContain('_googlecast');
  });
  it('collects a Chromecast from its answer', () => {
    const records = decodeRecords(response());
    expect(collectInstances('_googlecast._tcp.local', records)).toEqual([
      {
        instance: 'Chromecast-Audio-abc._googlecast._tcp.local',
        host: 'abc.local',
        port: 8009,
        addresses: ['192.168.1.42'],
        txt: { fn: 'Living Room Speaker', md: 'Chromecast Audio', id: 'abc' },
      },
    ]);
  });
});
