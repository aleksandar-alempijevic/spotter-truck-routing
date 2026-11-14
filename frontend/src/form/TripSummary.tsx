import { Box, Button, Typography } from '@mui/material';
import type { Ref } from 'react';
import { displayZone, placeName, type Trip } from '../plan/trip';
import { formatClockWithZone } from '../time/zone';

/**
 * The trip bar: the two places, then when, how heavy and how often to check. The details wrap
 * to a second line rather than being cut off, each kept whole. The button's name is its text.
 */
export function TripSummary({
  trip,
  breaksApplied,
  onClick,
  ref,
}: {
  trip: Trip;
  /** From the routes answer: undefined until it lands. Says which mode the plan was made in. */
  breaksApplied?: boolean;
  onClick(): void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const leaves = formatClockWithZone(trip.departureMs, displayZone(trip));
  const details = [leaves, `${trip.loadLb.toLocaleString('en-US')} lb`, `every ${trip.spacing} mi`];
  if (breaksApplied) details.push('with rest breaks');
  return (
    <Button
      ref={ref}
      fullWidth
      onClick={onClick}
      sx={{
        minHeight: 48,
        justifyContent: 'space-between',
        textAlign: 'left',
        color: 'text.primary',
        px: 2,
        py: 0.5,
      }}
    >
      <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          component="span"
          noWrap
          sx={{ display: 'block', fontWeight: 600 }}
        >
          {placeName(trip.origin.label)} → {placeName(trip.destination.label)}
        </Typography>
        <Typography
          variant="caption"
          component="span"
          color="text.secondary"
          sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, textTransform: 'none' }}
        >
          {details.map((part) => (
            <span key={part} style={{ whiteSpace: 'nowrap' }}>
              {part}
            </span>
          ))}
        </Typography>
      </Box>
      <Typography variant="body2" component="span" color="primary" sx={{ ml: 1, fontWeight: 600 }}>
        Edit
      </Typography>
    </Button>
  );
}
