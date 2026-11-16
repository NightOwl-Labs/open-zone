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
  vertical,
  hideValue,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  label: string;
  format?: (v: number) => string;
  disabled?: boolean;
  /** Render as a vertical fader (the input is rotated; drag up to increase). */
  vertical?: boolean;
  hideValue?: boolean;
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
    <div className={`slider${vertical ? ' vertical' : ''}`}>
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
      {!hideValue && <output className="slider-value">{format ? format(shown) : shown}</output>}
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

const ICONS = {
  power: (
    <>
      <path d="M12 3v8" />
      <path d="M6.3 7.3a8 8 0 1 0 11.4 0" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  tv: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </>
  ),
  disc: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  radio: (
    <>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M7 8l10-4" />
      <circle cx="15.5" cy="14" r="2.5" />
      <path d="M6 12h4M6 16h4" />
    </>
  ),
  game: (
    <>
      <path d="M6 9h12a4 4 0 0 1 3.9 4.8l-.6 3A2.5 2.5 0 0 1 17 18l-2-2H9l-2 2a2.5 2.5 0 0 1-4.3-1.2l-.6-3A4 4 0 0 1 6 9z" />
      <path d="M8 12v3M6.5 13.5h3M15.5 13h.01M17.5 15h.01" />
    </>
  ),
  bluetooth: <path d="M7 7l10 10-5 4V3l5 4L7 17" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  input: (
    <>
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
      <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </>
  ),
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

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
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
