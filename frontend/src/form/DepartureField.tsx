import { Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useState } from 'react';
import { toLocalInput, zoneAbbreviation, zoneName } from '../time/zone';
import type { DepartureValue } from './validation';

interface Props {
  value: DepartureValue;
  onChange(value: DepartureValue): void;
  /** The origin's time zone, once an origin is chosen. */
  zone: string | null;
  error?: string;
}

/** "Leave now", or a wall-clock time read in the origin's zone. */
export function DepartureField({ value, onChange, zone, error }: Props) {
  // Bounds for the native input; the submit check uses the time of the press, not this.
  const [openedAt] = useState(() => Date.now());

  return (
    <Stack spacing={1}>
      <Typography id="departure-label" variant="body2" sx={{ fontWeight: 600 }}>
        Departure
      </Typography>
      <ToggleButtonGroup
        exclusive
        fullWidth
        color="primary"
        aria-labelledby="departure-label"
        value={value.mode}
        onChange={(_, mode: DepartureValue['mode'] | null) => {
          if (mode === 'now') onChange({ mode: 'now' });
          if (mode === 'at') {
            onChange({ mode: 'at', local: zone ? toLocalInput(openedAt + 3_600_000, zone) : '' });
          }
        }}
      >
        <ToggleButton value="now" sx={{ minHeight: 48 }}>
          Leave now
        </ToggleButton>
        <ToggleButton value="at" sx={{ minHeight: 48 }}>
          Pick a time
        </ToggleButton>
      </ToggleButtonGroup>
      {value.mode === 'at' && (
        <TextField
          type="datetime-local"
          label="Departure date and time"
          value={value.local}
          disabled={zone === null}
          error={Boolean(error)}
          onChange={(event) => onChange({ mode: 'at', local: event.target.value })}
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: zone
              ? {
                  min: toLocalInput(openedAt - 10 * 60_000, zone),
                  max: toLocalInput(openedAt + 48 * 3_600_000, zone),
                }
              : {},
          }}
          helperText={
            error ??
            (zone
              ? `Read in ${zoneName(openedAt, zone)} (${zoneAbbreviation(openedAt, zone)}), the time zone of the starting place.`
              : 'Choose the starting place first: the time is read in its time zone.')
          }
        />
      )}
    </Stack>
  );
}
