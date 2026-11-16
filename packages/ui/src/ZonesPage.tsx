import type { ZoneView } from '@open-zone/shared';
import { ConsoleStrip } from './designs/ConsoleZones.tsx';
import { StudioRow } from './designs/StudioZones.tsx';
import { TileDetail } from './designs/TileDetail.tsx';
import { RoomTile } from './designs/TilesZones.tsx';
import type { Design } from './design.ts';
import { Toggle } from './components.tsx';
import { roleOf, sourceLabel, zoneLabel } from './format.ts';
import { useApp } from './store.ts';
import {
  FollowingLine,
  RoleBadge,
  SourceSelect,
  VolumeRow,
  ZoneDetail,
  change,
  isFollowing,
} from './zoneParts.tsx';

function ClassicCard({ z, onOpen }: { z: ZoneView; onOpen: () => void }) {
  const sources = useApp((s) => s.sources);
  const mirrors = useApp((s) => s.mirrors);
  const zones = useApp((s) => s.zones);
  const role = roleOf(z.zone, mirrors);
  const following = isFollowing(role);
  const on = z.state?.power ?? false;
  return (
    <article
      className={`card zone${on && !following ? ' on' : ''}${following ? ' following' : ''}${
        z.state?.mute ? ' muted' : ''
      }`}
    >
      <div className="zone-head">
        <button type="button" className="zone-title" onClick={onOpen}>
          <span className="name">{zoneLabel(z)}</span>
          {following ? (
            <FollowingLine role={role} zones={zones} />
          ) : (
            <>
              <span className="sub">
                {z.state ? (on ? sourceLabel(sources, z.state.source) : 'Off') : 'Not read yet'}
              </span>
              <RoleBadge role={role} zones={zones} />
            </>
          )}
        </button>
        {z.state && !following && (
          <Toggle
            label={`${zoneLabel(z)} power`}
            checked={on}
            onChange={(v) => change(z, { power: v })}
          />
        )}
      </div>
      {on && !following && (
        <div className="zone-body">
          <SourceSelect z={z} sources={sources} />
          <VolumeRow z={z} />
        </div>
      )}
    </article>
  );
}

export interface ZoneItemProps {
  z: ZoneView;
  onOpen: () => void;
}

const ITEM: Record<Design, (p: ZoneItemProps) => React.ReactNode> = {
  classic: ClassicCard,
  studio: StudioRow,
  console: ConsoleStrip,
  tiles: RoomTile,
};

export function ZonesPage({
  design,
  open,
  onOpen,
  onClose,
}: {
  design: Design;
  open: number | null;
  onOpen: (zone: number) => void;
  onClose: () => void;
}) {
  const allZones = useApp((s) => s.zones);
  const system = useApp((s) => s.system);
  const zones = allZones.filter((z) => z.enabled);
  if (allZones.length > 0 && zones.length === 0) {
    return (
      <div className="empty">
        <p>All zones are turned off.</p>
        <p className="muted-text">Turn on the zones you use in Settings → Zones.</p>
      </div>
    );
  }
  if (zones.length === 0) {
    return (
      <div className="empty">
        <p>No zones yet.</p>
        <p className="muted-text">
          {system?.connection.status === 'connected'
            ? 'The amplifier reported no zones.'
            : `Waiting for the amplifier${system?.connection.error ? `: ${system.connection.error}` : '…'}`}
        </p>
      </div>
    );
  }
  // Units and zone numbers are wiring details: they belong in Settings, not here.
  const Item = ITEM[design];
  const Detail = design === 'tiles' ? TileDetail : ZoneDetail;
  return (
    <>
      <div className={`zone-list zone-list-${design}`}>
        {zones.map((z) => (
          <Item key={z.zone} z={z} onOpen={() => onOpen(z.zone)} />
        ))}
      </div>
      {open !== null && <Detail zone={open} onClose={onClose} />}
    </>
  );
}
