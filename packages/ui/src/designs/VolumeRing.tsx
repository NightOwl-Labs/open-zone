const MAX = 38;

/** 270° volume gauge, open at the bottom. Purely visual. */
export function VolumeRing({
  value,
  muted,
  className = 't-ring',
}: {
  value: number;
  muted: boolean;
  className?: string;
}) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const arc = 0.75;
  const filled = (value / MAX) * arc * c;
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden>
      <circle
        cx="32"
        cy="32"
        r={r}
        className="t-ring-track"
        strokeDasharray={`${arc * c} ${c}`}
        transform="rotate(135 32 32)"
      />
      <circle
        cx="32"
        cy="32"
        r={r}
        className="t-ring-fill"
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(135 32 32)"
      />
      <text x="32" y="37" textAnchor="middle" className="t-ring-text">
        {muted ? '—' : value}
      </text>
    </svg>
  );
}
