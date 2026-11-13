import { Box, Button, Slider, Typography } from '@mui/material';
import { useMemo } from 'react';
import { formatClockWithZone } from '../time/zone';
import { hourInstant, type GridModel } from './grid';
import { useHour, type HourHolder } from './hourHolder';
import { sliderMarks } from './marks';
import { describeTruck, trucksAt, type TruckRoute } from './trucks';

interface Props {
  holder: HourHolder;
  /** Null until the weather lands; the bar holds its space meanwhile. */
  model: GridModel | null;
  zone: string;
  /** For the truck readout and the "Now" mark. */
  routes?: readonly TruckRoute[];
  nowMs?: number;
}

const STEP_SX = { minWidth: 44, minHeight: 44, px: 0, fontWeight: 700, flexShrink: 0 } as const;

/**
 * The hourly slider: marks, one-hour buttons, tap-on-track and a clock-time label. It writes to
 * the hour holder and never touches the map; the map and this bar both listen to the holder.
 */
export function HourSlider({ holder, model, zone, routes = [], nowMs = 0 }: Props) {
  const hour = useHour(holder);
  const last = model ? model.hourCount - 1 : 0;
  const marks = useMemo(() => (model ? sliderMarks(model, zone, nowMs) : []), [model, zone, nowMs]);

  const clock = (h: number) => (model ? formatClockWithZone(hourInstant(model, h), zone) : '');
  // What the bar says depends on the hour on screen, so a re-render at the same hour reuses it.
  const label = useMemo(
    () => (model ? formatClockWithZone(hourInstant(model, hour), zone) : ''),
    [model, hour, zone],
  );
  const atDeparture = model !== null && Math.round(model.departureHour) === hour;
  const trucks = useMemo(
    () => (model && routes.length > 0 ? trucksAt(routes, hourInstant(model, hour)) : []),
    [model, routes, hour],
  );

  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, minHeight: 24 }}>
        <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
          Forecast hour
        </Typography>
        <Typography variant="body2" component="span" aria-live="polite">
          {model
            ? `${label} · +${hour} h${atDeparture ? ' · departure' : ''}`
            : 'Waiting for the forecast'}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          aria-label="Back one hour"
          variant="outlined"
          size="small"
          sx={STEP_SX}
          disabled={!model || hour <= 0}
          onClick={() => holder.set(Math.max(0, hour - 1))}
        >
          −1 h
        </Button>
        <Slider
          aria-label="Forecast hour"
          min={0}
          max={model ? last : 1}
          step={1}
          marks={marks}
          value={model ? hour : 0}
          disabled={model === null}
          onChange={(_, value) => holder.set(value as number)}
          getAriaValueText={(h) =>
            model ? `${clock(h)}, ${h} hours from the start of the forecast` : ''
          }
          sx={{
            flex: 1,
            height: 6,
            '& .MuiSlider-thumb': { width: 28, height: 28 },
            '& .MuiSlider-markLabel': { fontSize: 12 },
            // The first label would sit under the one-hour button, so it starts at the track's edge.
            '& .MuiSlider-markLabel[data-index="0"]': { transform: 'none' },
            // A 44 px tall touch band around the thin rail, with room for the mark labels.
            py: '19px',
            mb: marks.some((m) => m.label) ? 2 : 0,
          }}
        />
        <Button
          aria-label="Forward one hour"
          variant="outlined"
          size="small"
          sx={STEP_SX}
          disabled={!model || hour >= last}
          onClick={() => holder.set(Math.min(last, hour + 1))}
        >
          +1 h
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ minHeight: 20 }}>
        {trucks.length > 0 ? `Trucks: ${trucks.map(describeTruck).join(' · ')}` : ''}
      </Typography>
    </Box>
  );
}
