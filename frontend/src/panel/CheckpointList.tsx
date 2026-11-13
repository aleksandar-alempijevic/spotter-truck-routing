import { Box, ButtonBase, Typography } from '@mui/material';
import { useEffect, useRef, type Ref } from 'react';
import type { CheckpointRef } from '../map/types';
import type { Trip } from '../plan/trip';
import type { CheckpointView, RouteView } from '../plan/view';
import { RiskBadge } from '../risk/RiskBadge';
import { zoneName } from '../time/zone';
import { displayZone } from '../plan/trip';
import { originClock } from './times';

interface Props {
  route: RouteView;
  trip: Trip;
  selected: CheckpointRef | null;
  onSelect(ref: CheckpointRef): void;
}

/** What the checkpoint's weather was, in the driver's units. */
export function conditionsText(cp: CheckpointView): string {
  if (cp.risk.kind === 'pending') return 'Weather not checked yet';
  if (cp.risk.kind === 'none' || !cp.conditions) return 'No forecast for this time';
  const c = cp.conditions;
  return `Wind ${c.wind_mph} mph (gusts ${c.gust_mph}) · Rain ${c.rain_in_per_hr} in/h · Snow ${c.snow_in_per_hr} in/h`;
}

interface RowProps {
  route: RouteView;
  cp: CheckpointView;
  trip: Trip;
  isSelected: boolean;
  onSelect(ref: CheckpointRef): void;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** One checkpoint: mile, ETA, level and conditions. */
export function CheckpointRow({ route, cp, trip, isSelected, onSelect, buttonRef }: RowProps) {
  return (
    <ButtonBase
      ref={buttonRef}
      aria-current={isSelected ? 'true' : undefined}
      onClick={() => onSelect({ routeId: route.id, index: cp.index })}
      sx={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        minHeight: 56,
        px: 1,
        py: 0.75,
        borderBottom: 1,
        borderColor: 'divider',
        borderLeft: 4,
        borderLeftColor: isSelected ? 'primary.main' : 'transparent',
        bgcolor: isSelected ? 'action.selected' : 'transparent',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Mile {Math.round(cp.mile)} · {originClock(trip, cp.etaMs)}
        </Typography>
        <Typography variant="body2" component="span">
          <RiskBadge state={cp.risk} />
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {conditionsText(cp)}
      </Typography>
    </ButtonBase>
  );
}

/** The selected route's checkpoints in order. */
export function CheckpointList({ route, trip, selected, onSelect }: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const selectedIndex = selected?.routeId === route.id ? selected.index : null;

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {route.name} checkpoints
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
        Times are in {zoneName(trip.departureMs, displayZone(trip))}, the starting place&apos;s time
        zone.
      </Typography>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {route.checkpoints.map((cp) => {
          const isSelected = cp.index === selectedIndex;
          return (
            <li key={cp.index}>
              <CheckpointRow
                route={route}
                cp={cp}
                trip={trip}
                isSelected={isSelected}
                onSelect={onSelect}
                buttonRef={isSelected ? selectedRef : undefined}
              />
            </li>
          );
        })}
      </Box>
    </Box>
  );
}
