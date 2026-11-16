import type { ControllerEvent, ControllerEventType } from '@open-zone/shared';

type Handler<E> = (event: E) => void;
type EventOf<T extends ControllerEventType> = Extract<ControllerEvent, { type: T }>;

/**
 * Synchronous in-process pub/sub. API adapters (REST/WS today, MQTT or
 * Home Assistant later) subscribe here; the core never knows who listens.
 */
export class EventBus {
  private readonly all = new Set<Handler<ControllerEvent>>();
  private readonly byType = new Map<ControllerEventType, Set<Handler<ControllerEvent>>>();
  private readonly onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(handler: Handler<ControllerEvent>): () => void {
    this.all.add(handler);
    return () => this.all.delete(handler);
  }

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<T extends ControllerEventType>(type: T, handler: Handler<EventOf<T>>): () => void {
    let set = this.byType.get(type);
    if (!set) this.byType.set(type, (set = new Set()));
    const h = handler as Handler<ControllerEvent>;
    set.add(h);
    return () => set.delete(h);
  }

  emit(event: ControllerEvent): void {
    const handlers = [...this.all, ...(this.byType.get(event.type) ?? [])];
    for (const h of handlers) {
      try {
        h(event);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
