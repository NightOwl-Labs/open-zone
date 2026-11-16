import type {
  Config,
  MirrorGroup,
  PollingConfig,
  SourceView,
  SystemView,
  ZonePatch,
  ZoneView,
} from '@open-zone/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly issues: string[];
  constructor(message: string, status: number, issues: string[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    (T & { message?: string; issues?: string[] }) | null;
  if (!res.ok) {
    throw new ApiError(data?.message ?? res.statusText, res.status, data?.issues ?? []);
  }
  return data as T;
}

export interface MirrorInput {
  name?: string;
  enabled?: boolean;
  primary?: number;
  followers?: Array<{ zone: number; volumeOffset: number }>;
}

export interface Snapshot {
  system: SystemView;
  zones: ZoneView[];
  sources: SourceView[];
  mirrors: MirrorGroup[];
  config: Config;
}

export const api = {
  snapshot: () => request<Snapshot>('GET', '/snapshot'),
  zone: (id: number) => request<ZoneView>('GET', `/zones/${id}`),
  setZone: (id: number, patch: ZonePatch) => request<ZoneView>('PATCH', `/zones/${id}`, patch),
  renameZone: (id: number, name: string | null) =>
    request<ZoneView>('PUT', `/zones/${id}/name`, { name }),
  updateSource: (id: number, input: { name?: string | null; enabled?: boolean }) =>
    request<SourceView>('PATCH', `/sources/${id}`, input),
  createMirror: (input: MirrorInput) => request<MirrorGroup>('POST', '/mirrors', input),
  updateMirror: (id: string, input: MirrorInput) =>
    request<MirrorGroup>('PATCH', `/mirrors/${id}`, input),
  deleteMirror: (id: string) => request<void>('DELETE', `/mirrors/${id}`),
  updatePolling: (polling: Partial<PollingConfig>) =>
    request<Config>('PATCH', '/config', { polling }),
  simulateKeypad: (zone: number, body: { patch?: ZonePatch; keypad?: boolean }) =>
    request<void>('POST', '/simulator/keypad', { zone, ...body }),
};
