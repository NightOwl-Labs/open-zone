import { useState } from 'react';
import { TILE_COLOR_IDS, type TileColor } from '@open-zone/shared';
import { Icon } from './components.tsx';
import { PALETTE, SHADE_COUNT } from './designs/palette.ts';

/** The 6 volume shades of a color, quiet → loud. */
export function ShadeRamp({ color, className = '' }: { color: TileColor; className?: string }) {
  return (
    <span className={`shade-ramp ${className}`} aria-hidden>
      {PALETTE[color].shades.map((hex) => (
        <span key={hex} style={{ background: hex }} />
      ))}
    </span>
  );
}

/**
 * A row showing the current color; tap it to open a 4×4 grid of the 16 tile
 * colors inline, with a quiet → loud preview of the picked color.
 */
export function ColorPicker({
  label,
  value,
  isDefault,
  onChange,
}: {
  label: string;
  value: TileColor;
  /** True when no color was chosen and `value` is the default. */
  isDefault: boolean;
  /** null resets to the default. */
  onChange: (color: TileColor | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const mid = PALETTE[value].shades[Math.floor(SHADE_COUNT / 2)];
  return (
    <div className={`color-picker${open ? ' open' : ''}`}>
      <button
        type="button"
        className="color-row"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="color-dot" style={{ background: mid }} aria-hidden />
        <span className="color-row-text">
          <b>{label}</b>
          <span className="muted-text small">
            {PALETTE[value].label}
            {isDefault ? ' (default)' : ''}
          </span>
        </span>
        <ShadeRamp color={value} />
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="color-panel">
          <div className="color-grid" role="radiogroup" aria-label={`${label} color`}>
            {TILE_COLOR_IDS.map((id) => (
              <button
                type="button"
                key={id}
                role="radio"
                aria-checked={id === value}
                aria-label={PALETTE[id].label}
                title={PALETTE[id].label}
                className={`color-swatch${id === value ? ' active' : ''}`}
                style={{
                  background: `linear-gradient(135deg, ${PALETTE[id].shades[0]}, ${PALETTE[id].shades[SHADE_COUNT - 1]})`,
                }}
                onClick={() => onChange(id)}
              />
            ))}
          </div>
          <div className="color-preview">
            <span className="muted-text small">Quiet</span>
            <ShadeRamp color={value} className="large" />
            <span className="muted-text small">Loud</span>
          </div>
          {!isDefault && (
            <button type="button" className="btn small" onClick={() => onChange(null)}>
              Use default
            </button>
          )}
        </div>
      )}
    </div>
  );
}
