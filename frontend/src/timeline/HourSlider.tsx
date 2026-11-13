import { Box, Button, Slider, Typography } from '@mui/material';
import { useMemo } from 'react';
import { RISK_STYLE } from '../risk/levels';
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
  /** The weather request failed, so the bar says so instead of waiting for the forecast. */
  weatherFailed?: boolean;
}

const STEP_SX = { minWidth: 44, minHeight: 44, px: 0, fontWeight: 700, flexShrink: 0 } as const;

/**
 * The hourly slider: marks, one-hour buttons, tap-on-track and a clock-time label. It writes to
 * the hour holder and never touches the map; the map and this bar both listen to the holder.
 */
export function HourSlider({
  holder,
  model,
  zone,
  routes = [],
  nowMs = 0,
  weatherFailed = false,
}: Props) {
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
      {/* The bar is the same height whether the weather has landed or not and whatever the hour
          says: every line here is one line tall, cut short with an ellipsis if it must be. A change
          of height would re-fit the map in the middle of a drag. The clock label is not a live
          region: the slider announces its own value as it moves. */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, height: 24 }}>
        <Typography variant="body2" component="span" noWrap sx={{ fontWeight: 600, flexShrink: 0 }}>
          Forecast hour
        </Typography>
        <Typography variant="body2" component="span" noWrap sx={{ minWidth: 0 }}>
          {model
            ? `${label} · +${hour} h${atDeparture ? ' · departure' : ''}`
            : weatherFailed
              ? RISK_STYLE.unavailable.label
              : 'Waiting for the forecast'}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          aria-label="−1 h, back one hour"
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
            // Room for the mark labels, kept before the marks exist so the bar does not grow.
            mb: 2,
          }}
        />
        <Button
          aria-label="+1 h, forward one hour"
          variant="outlined"
          size="small"
          sx={STEP_SX}
          disabled={!model || hour >= last}
          onClick={() => holder.set(Math.min(last, hour + 1))}
        >
          +1 h
        </Button>
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        component="p"
        noWrap
        sx={{ height: 20, lineHeight: '20px' }}
      >
        {/* Cut short by the ellipsis, whole to a screen reader. */}
        {trucks.length > 0 ? `Trucks: ${trucks.map(describeTruck).join(' · ')}` : ''}
      </Typography>
    </Box>
  );
}
