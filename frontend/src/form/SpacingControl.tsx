import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { Spacing } from '../api/types';
import { SPACINGS } from '../plan/trip';

/** Shown when the shortest spacing is chosen: the weather check asks for the most points then. */
const LONG_TRIP_NOTICE =
  'Checking every 10 miles gives the most detail, but on a long trip the weather can take about a minute.';

export function SpacingControl({
  value,
  onChange,
}: {
  value: Spacing;
  onChange(value: Spacing): void;
}) {
  return (
    <Stack spacing={1}>
      <Typography id="spacing-label" variant="body2" sx={{ fontWeight: 600 }}>
        Check the weather every
      </Typography>
      <ToggleButtonGroup
        exclusive
        fullWidth
        color="primary"
        aria-labelledby="spacing-label"
        value={value}
        onChange={(_, next: Spacing | null) => {
          if (next !== null) onChange(next);
        }}
      >
        {SPACINGS.map((miles) => (
          <ToggleButton key={miles} value={miles} sx={{ minHeight: 48 }}>
            {miles} mi
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {value === 10 && (
        <Typography variant="caption" color="text.secondary">
          {LONG_TRIP_NOTICE}
        </Typography>
      )}
    </Stack>
  );
}
