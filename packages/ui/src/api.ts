import type {
  ActivationResult,
  Config,
  Scene,
  MirrorGroup,
  PollingConfig,
  DiscoveredStreamer,
  NowPlayingView,
  StreamerLink,
  StreamerStatusView,
  AppearanceConfig,
  TileColor,
  QuietView,
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
  followers?: Array<{ zone: number; volumeOffset: number; sub?: boolean }>;
}

export interface StreamersSnapshot {
  links: StreamerLink[];
  status: StreamerStatusView[];
  nowPlaying: NowPlayingView[];
  /** False when the server runs without the streamer integration. */
  enabled: boolean;
}

export interface Snapshot {
  streamers: StreamersSnapshot;
  system: SystemView;
  zones: ZoneView[];
  sources: SourceView[];
  mirrors: MirrorGroup[];
  scenes: Scene[];
  config: Config;
}

export interface SceneInput {
  name: string;
  source: number;
  zones: Array<{ zone: number; volume: number }>;
  othersOff: boolean;
}

export const api = {
  snapshot: () => request<Snapshot>('GET', '/snapshot'),
  zone: (id: number) => request<ZoneView>('GET', `/zones/${id}`),
  setZone: (id: number, patch: ZonePatch) => request<ZoneView>('PATCH', `/zones/${id}`, patch),
  updateZone: (
    id: number,
    input: { name?: string | null; enabled?: boolean; color?: TileColor | null },
  ) => request<ZoneView>('PATCH', `/zones/${id}/config`, input),
  updateSource: (
    id: number,
    input: { name?: string | null; enabled?: boolean; color?: TileColor | null },
  ) => request<SourceView>('PATCH', `/sources/${id}`, input),
  createMirror: (input: MirrorInput) => request<MirrorGroup>('POST', '/mirrors', input),
  updateMirror: (id: string, input: MirrorInput) =>
    request<MirrorGroup>('PATCH', `/mirrors/${id}`, input),
  deleteMirror: (id: string) => request<void>('DELETE', `/mirrors/${id}`),
  setFollowerLevel: (id: string, zone: number, volumeOffset: number) =>
    request<MirrorGroup>('PUT', `/mirrors/${id}/followers/${zone}/level`, { volumeOffset }),
  allOff: () => request<ActivationResult>('POST', '/zones/all-off'),
  muteAll: () => request<QuietView>('POST', '/zones/mute-all'),
  unmuteAll: () => request<QuietView>('POST', '/zones/unmute-all'),
  lowerAll: (steps: number) => request<QuietView>('POST', '/zones/lower-all', { steps }),
  restoreVolume: () => request<QuietView>('POST', '/zones/restore-volume'),
  createScene: (input: SceneInput) => request<Scene>('POST', '/scenes', input),
  updateScene: (id: string, input: Partial<SceneInput>) =>
    request<Scene>('PATCH', `/scenes/${id}`, input),
  deleteScene: (id: string) => request<void>('DELETE', `/scenes/${id}`),
  activateScene: (id: string) => request<ActivationResult>('POST', `/scenes/${id}/activate`),
  updateHome: (name: string | null) => request<Config>('PATCH', '/config', { home: { name } }),
  updateAppearance: (appearance: Partial<AppearanceConfig>) =>
    request<Config>('PATCH', '/config', { appearance }),
  updatePolling: (polling: Partial<PollingConfig>) =>
    request<Config>('PATCH', '/config', { polling }),
  discoverStreamers: () => request<DiscoveredStreamer[]>('GET', '/streamers/discover'),
  linkStreamer: (input: { type: 'cast'; deviceId: string; name: string; source: number }) =>
    request<StreamerLink>('POST', '/streamers', input),
  updateStreamer: (id: string, input: { source?: number; name?: string }) =>
    request<StreamerLink>('PATCH', `/streamers/${id}`, input),
  unlinkStreamer: (id: string) => request<void>('DELETE', `/streamers/${id}`),
  simulateKeypad: (zone: number, body: { patch?: ZonePatch; keypad?: boolean }) =>
    request<void>('POST', '/simulator/keypad', { zone, ...body }),
};
