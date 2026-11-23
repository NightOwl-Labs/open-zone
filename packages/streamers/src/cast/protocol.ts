/**
 * Google Cast v2 wire format: each message is a 4-byte big-endian length
 * followed by a protobuf `CastMessage`:
 *   1 protocol_version (enum, 0 = CASTV2_1_0)   2 source_id   3 destination_id
 *   4 namespace   5 payload_type (0 = STRING)   6 payload_utf8   7 payload_binary
 * Only string payloads are used. The protobuf is small enough to hand-encode.
 */

export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** JSON payload (string payloads only). */
  payload: string;
}

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
  multizone: 'urn:x-cast:com.google.cast.multizone',
} as const;

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function field(tag: number, value: string | number): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(tag << 3), varint(value)]);
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([varint((tag << 3) | 2), varint(bytes.length), bytes]);
}

export function encodeMessage(m: CastMessage): Buffer {
  const body = Buffer.concat([
    field(1, 0),
    field(2, m.sourceId),
    field(3, m.destinationId),
    field(4, m.namespace),
    field(5, 0),
    field(6, m.payload),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    if (b === undefined) throw new Error('truncated varint');
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
}

export function decodeMessage(body: Buffer): CastMessage {
  const m: CastMessage = { sourceId: '', destinationId: '', namespace: '', payload: '' };
  let pos = 0;
  while (pos < body.length) {
    const [key, p1] = readVarint(body, pos);
    const tag = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      pos = readVarint(body, p1)[1];
    } else if (wire === 2) {
      const [len, p2] = readVarint(body, p1);
      const s = body.toString('utf8', p2, p2 + len);
      if (tag === 2) m.sourceId = s;
      else if (tag === 3) m.destinationId = s;
      else if (tag === 4) m.namespace = s;
      else if (tag === 6) m.payload = s;
      pos = p2 + len;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return m;
}

/** Splits a TCP byte stream into length-prefixed Cast messages. */
export class FrameReader {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): CastMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: CastMessage[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 1 << 20) throw new Error(`cast frame too large (${len} bytes)`);
      if (this.buf.length < 4 + len) break;
      out.push(decodeMessage(this.buf.subarray(4, 4 + len)));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
