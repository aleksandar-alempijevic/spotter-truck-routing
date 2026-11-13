import { Box, Slider, Typography } from '@mui/material';
import { formatClock, zoneAbbreviation } from '../time/zone';
import { hourInstant, type GridModel } from './grid';
import { useHour, type HourHolder } from './hourHolder';

interface Props {
  holder: HourHolder;
  /** Null until the weather lands; the bar holds its space meanwhile. */
  model: GridModel | null;
  zone: string;
}

/** A plain hourly slider with a clock-time label. It writes to the holder and never touches the map. */
export function HourSlider({ holder, model, zone }: Props) {
  const hour = useHour(holder);

  const clock = (h: number) =>
    model
      ? `${formatClock(hourInstant(model, h), zone)} ${zoneAbbreviation(hourInstant(model, h), zone)}`
      : '';
  const atDeparture = model !== null && Math.round(model.departureHour) === hour;

  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, minHeight: 24 }}>
        <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
          Forecast hour
        </Typography>
        <Typography variant="body2" component="span" aria-live="polite">
          {model
            ? `${clock(hour)} · +${hour} h${atDeparture ? ' · departure' : ''}`
            : 'Waiting for the forecast'}
        </Typography>
      </Box>
      <Slider
        aria-label="Forecast hour"
        min={0}
        max={model ? model.hourCount - 1 : 1}
        step={1}
        value={model ? hour : 0}
        disabled={model === null}
        onChange={(_, value) => holder.set(value as number)}
        getAriaValueText={(h) =>
          model ? `${clock(h)}, ${h} hours from the start of the forecast` : ''
        }
        sx={{
          height: 6,
          '& .MuiSlider-thumb': { width: 28, height: 28 },
          // A 44 px tall touch band around the thin rail.
          py: '19px',
        }}
      />
    </Box>
  );
}
