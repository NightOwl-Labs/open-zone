import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dismissToast, useApp } from './store.ts';

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/** Calls `fn` at most every `ms` while values stream in, always delivering the last one. */
function useThrottle(fn: (v: number) => void, ms: number) {
  const ref = useRef({
    fn,
    last: 0,
    pending: undefined as number | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  ref.current.fn = fn;
  return useMemo(() => {
    const fire = () => {
      const r = ref.current;
      clearTimeout(r.timer);
      r.timer = undefined;
      if (r.pending === undefined) return;
      const v = r.pending;
      r.pending = undefined;
      r.last = Date.now();
      r.fn(v);
    };
    return {
      push(v: number) {
        const r = ref.current;
        r.pending = v;
        const wait = ms - (Date.now() - r.last);
        if (wait <= 0) fire();
        else r.timer ??= setTimeout(fire, wait);
      },
      flush: fire,
    };
  }, [ms]);
}

/**
 * Range slider that stays responsive while dragging: the thumb follows the
 * finger locally, updates go out at most every 150 ms, and the final value is
 * always sent on release.
 */
export function Slider({
  value,
  min,
  max,
  onCommit,
  label,
  format,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  label: string;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const throttle = useThrottle(onCommit, 150);
  const shown = local ?? value;
  const end = () => {
    throttle.flush();
    setLocal(null);
  };
  const pct = ((shown - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={shown}
        aria-label={label}
        aria-valuetext={format ? format(shown) : String(shown)}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          setLocal(v);
          throttle.push(v);
        }}
        onPointerUp={end}
        onTouchEnd={end}
        onKeyUp={end}
        onBlur={() => local !== null && end()}
      />
      <output className="slider-value">{format ? format(shown) : shown}</output>
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button
          type="button"
          key={t.id}
          className={`toast ${t.kind}`}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function StatusPill() {
  const socket = useApp((s) => s.socket);
  const system = useApp((s) => s.system);
  let kind = 'ok';
  let text = system?.simulator ? 'Simulator' : 'Connected';
  if (socket !== 'open') {
    kind = 'warn';
    text = socket === 'connecting' ? 'Connecting…' : 'Offline';
  } else if (system && system.connection.status !== 'connected') {
    kind = 'bad';
    text = system.connection.status === 'connecting' ? 'Finding amp…' : 'Amp offline';
  }
  return (
    <span className={`pill ${kind}`} title={system?.connection.error ?? undefined}>
      <span className="dot" />
      {text}
    </span>
  );
}

/** Text input that saves on blur or Enter, only when the value changed. */
export function NameInput({
  value,
  placeholder,
  onSave,
  label,
}: {
  value: string | null;
  placeholder: string;
  onSave: (v: string | null) => void;
  label: string;
}) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const save = () => {
    const next = text.trim() || null;
    if (next !== value) onSave(next);
  };
  return (
    <input
      className="text"
      value={text}
      placeholder={placeholder}
      aria-label={label}
      maxLength={40}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

const ICONS: Record<string, ReactNode> = {
  zones: (
    <>
      <path d="M5 15V9M10 18V6M15 15V9M20 13v-2" />
    </>
  ),
  mirrors: (
    <>
      <rect x="3" y="5" width="8" height="14" rx="2" />
      <rect x="13" y="5" width="8" height="14" rx="2" />
      <path d="M7 9v6M17 9v6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  muted: (
    <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M17 9l4 6M21 9l-4 6" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  keypad: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M10 8h4M10 12h4M10 16h4" />
    </>
  ),
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
