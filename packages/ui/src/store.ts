import { useSyncExternalStore } from 'react';
import type {
  Config,
  ControllerEvent,
  MirrorGroup,
  SourceView,
  SystemView,
  ZonePatch,
  ZoneView,
} from '@open-zone/shared';
import { ApiError, api, type Snapshot } from './api.ts';
import { zoneLabel } from './format.ts';

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface AppState {
  socket: 'connecting' | 'open' | 'closed';
  system: SystemView | null;
  zones: ZoneView[];
  sources: SourceView[];
  mirrors: MirrorGroup[];
  config: Config | null;
  toasts: Toast[];
}

let state: AppState = {
  socket: 'connecting',
  system: null,
  zones: [],
  sources: [],
  mirrors: [],
  config: null,
  toasts: [],
};
const listeners = new Set<() => void>();

function update(fn: (s: AppState) => AppState): void {
  state = fn(state);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Select a slice of app state. Selectors must return existing references, not new objects. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function getState(): AppState {
  return state;
}

// ───────────────────────────── toasts ─────────────────────────────

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  update((s) => ({ ...s, toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 6000 : 4000);
}

export function dismissToast(id: number): void {
  update((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError && err.issues.length) return err.issues.join('\n');
  return err instanceof Error ? err.message : String(err);
}

// ───────────────────────────── live connection ─────────────────────────────

let socket: WebSocket | undefined;
let retryMs = 500;

export function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  update((s) => ({ ...s, socket: 'connecting' }));
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/v1/events`);
  socket = ws;
  ws.onopen = () => {
    retryMs = 500;
    update((s) => ({ ...s, socket: 'open' }));
  };
  ws.onmessage = (m) => handle(JSON.parse(String(m.data)) as ServerMessage);
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    update((s) => ({ ...s, socket: 'closed' }));
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}

// Phones suspend background tabs: reconnect promptly when the app comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connect();
});

type ServerMessage = ControllerEvent | ({ type: 'snapshot' } & Snapshot) | { type: 'pong' };

function applySnapshot(snap: Snapshot): void {
  update((s) => ({
    ...s,
    system: snap.system,
    zones: snap.zones,
    sources: snap.sources,
    mirrors: snap.mirrors,
    config: snap.config,
  }));
}

function patchZone(zone: number, fn: (z: ZoneView) => ZoneView): void {
  update((s) => ({ ...s, zones: s.zones.map((z) => (z.zone === zone ? fn(z) : z)) }));
}

function nameOf(zone: number): string {
  const z = state.zones.find((x) => x.zone === zone);
  return z ? zoneLabel(z) : `Zone ${zone}`;
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'snapshot':
      return applySnapshot(msg);
    case 'zone.changed':
      return patchZone(msg.zone, (z) => ({ ...z, state: msg.state, updatedAt: Date.now() }));
    case 'zone.renamed':
      return patchZone(msg.zone, (z) => ({ ...z, name: msg.name }));
    case 'source.renamed':
      return update((s) => ({
        ...s,
        sources: s.sources.map((x) => (x.source === msg.source ? { ...x, name: msg.name } : x)),
      }));
    case 'mirror.updated':
      return update((s) => ({
        ...s,
        mirrors: s.mirrors.some((g) => g.id === msg.group.id)
          ? s.mirrors.map((g) => (g.id === msg.group.id ? msg.group : g))
          : [...s.mirrors, msg.group],
      }));
    case 'mirror.deleted':
      return update((s) => ({ ...s, mirrors: s.mirrors.filter((g) => g.id !== msg.groupId) }));
    case 'mirror.offsetChanged': {
      const sign = msg.volumeOffset > 0 ? '+' : '';
      return toast(`${nameOf(msg.zone)} now follows at ${sign}${msg.volumeOffset} volume`);
    }
    case 'mirror.childDetached': {
      const why =
        msg.reason === 'keypad-detected'
          ? 'a keypad was connected'
          : `its ${msg.property ?? 'settings'} changed`;
      return toast(`${nameOf(msg.zone)} left the mirror because ${why}`);
    }
    case 'connection.changed':
      update((s) =>
        s.system
          ? {
              ...s,
              system: {
                ...s.system,
                connection: {
                  ...s.system.connection,
                  status: msg.status,
                  error: msg.error ?? null,
                },
              },
            }
          : s,
      );
      if (msg.status === 'connected') void refresh();
      return;
    case 'command.failed':
      return toast(
        `Couldn't update ${msg.zone ? nameOf(msg.zone) : 'the amp'}: ${msg.error}`,
        'error',
      );
    case 'pong':
      return;
  }
}

export async function refresh(): Promise<void> {
  try {
    applySnapshot(await api.snapshot());
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

// ───────────────────────────── actions ─────────────────────────────

/** Optimistically apply a change, send it, and roll back from the server on failure. */
export async function setZone(zone: number, patch: ZonePatch): Promise<void> {
  patchZone(zone, (z) => (z.state ? { ...z, state: { ...z.state, ...patch } } : z));
  try {
    const view = await api.setZone(zone, patch);
    patchZone(zone, (z) => ({ ...z, state: view.state, updatedAt: view.updatedAt }));
  } catch (err) {
    toast(errorText(err), 'error');
    try {
      const view = await api.zone(zone);
      patchZone(zone, () => view);
    } catch {
      /* the live connection will resync */
    }
  }
}

export async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(errorText(err), 'error');
    return undefined;
  }
}
