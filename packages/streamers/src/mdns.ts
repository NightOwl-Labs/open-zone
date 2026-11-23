/**
 * Minimal mDNS service browser (RFC 6762/6763), enough to find streamers on
 * the LAN without extra dependencies.
 *
 * It sends a one-shot ("legacy unicast") query from an ephemeral port to the
 * mDNS group; responders answer straight back to that port. This avoids
 * fighting the OS's own mDNS daemon for port 5353.
 */
import { createSocket } from 'node:dgram';

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const;

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  data:
    | { kind: 'ptr'; name: string }
    | { kind: 'srv'; port: number; target: string }
    | { kind: 'txt'; entries: Record<string, string> }
    | { kind: 'a'; address: string }
    | { kind: 'other' };
}

/** A discovered service instance, e.g. one Chromecast. */
export interface ServiceInstance {
  /** Full instance name, e.g. "Chromecast-Audio-3f…._googlecast._tcp.local". */
  instance: string;
  host: string | null;
  port: number | null;
  addresses: string[];
  txt: Record<string, string>;
}

export function encodeQuery(service: string, id = 0): Buffer {
  const labels = service.split('.').filter(Boolean);
  const name = Buffer.concat([
    ...labels.map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.PTR, 0);
  tail.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, name, tail]);
}

function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let hops = 0; hops < 64; hops++) {
    const len = buf[pos];
    if (len === undefined) throw new Error('truncated name');
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = buf.readUInt16BE(pos) & 0x3fff;
      if (end < 0) end = pos + 2;
      pos = ptr;
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join('.'), end >= 0 ? end : pos];
}

function readTxt(buf: Buffer, start: number, end: number): Record<string, string> {
  const entries: Record<string, string> = {};
  let pos = start;
  while (pos < end) {
    const len = buf[pos]!;
    const s = buf.toString('utf8', pos + 1, pos + 1 + len);
    const eq = s.indexOf('=');
    if (eq > 0) entries[s.slice(0, eq)] = s.slice(eq + 1);
    else if (s) entries[s] = '';
    pos += 1 + len;
  }
  return entries;
}

/** Parse every answer, authority and additional record in a DNS message. */
export function decodeRecords(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;
  const records: DnsRecord[] = [];
  for (let i = 0; i < total; i++) {
    const [name, after] = readName(buf, pos);
    const type = buf.readUInt16BE(after);
    const ttl = buf.readUInt32BE(after + 4);
    const len = buf.readUInt16BE(after + 8);
    const rd = after + 10;
    let data: DnsRecord['data'] = { kind: 'other' };
    if (type === TYPE.PTR) data = { kind: 'ptr', name: readName(buf, rd)[0] };
    else if (type === TYPE.SRV)
      data = { kind: 'srv', port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6)[0] };
    else if (type === TYPE.TXT) data = { kind: 'txt', entries: readTxt(buf, rd, rd + len) };
    else if (type === TYPE.A)
      data = { kind: 'a', address: [...buf.subarray(rd, rd + 4)].join('.') };
    records.push({ name, type, ttl, data });
    pos = rd + len;
  }
  return records;
}

/** Fold records (from any number of responses) into service instances. */
export function collectInstances(service: string, records: DnsRecord[]): ServiceInstance[] {
  const lc = (s: string) => s.toLowerCase();
  const instances = new Map<string, ServiceInstance>();
  for (const r of records) {
    if (r.data.kind === 'ptr' && lc(r.name) === lc(service)) {
      instances.set(lc(r.data.name), {
        instance: r.data.name,
        host: null,
        port: null,
        addresses: [],
        txt: {},
      });
    }
  }
  for (const r of records) {
    const inst = instances.get(lc(r.name));
    if (!inst) continue;
    if (r.data.kind === 'srv') {
      inst.host = r.data.target;
      inst.port = r.data.port;
    } else if (r.data.kind === 'txt') {
      inst.txt = { ...inst.txt, ...r.data.entries };
    }
  }
  for (const inst of instances.values()) {
    if (!inst.host) continue;
    for (const r of records) {
      if (
        r.data.kind === 'a' &&
        lc(r.name) === lc(inst.host) &&
        !inst.addresses.includes(r.data.address)
      ) {
        inst.addresses.push(r.data.address);
      }
    }
  }
  return [...instances.values()];
}

/**
 * Browse for a service type, e.g. "_googlecast._tcp.local", for `timeoutMs`.
 * The query is repeated a few times because multicast is lossy.
 */
export async function browse(
  service: string,
  options: { timeoutMs?: number; onRaw?: (from: string, msg: Buffer) => void } = {},
): Promise<ServiceInstance[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const records: DnsRecord[] = [];
  socket.on('message', (msg, rinfo) => {
    options.onRaw?.(rinfo.address, msg);
    try {
      records.push(...decodeRecords(msg));
    } catch {
      /* ignore malformed packets */
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => resolve());
  });
  const query = encodeQuery(service);
  const send = () => socket.send(query, MDNS_PORT, MDNS_GROUP);
  send();
  const repeats = [250, 1000].filter((t) => t < timeoutMs).map((t) => setTimeout(send, t));
  await new Promise((r) => setTimeout(r, timeoutMs));
  repeats.forEach(clearTimeout);
  socket.close();
  return collectInstances(service, records);
}
