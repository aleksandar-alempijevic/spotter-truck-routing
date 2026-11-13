import { Button, Typography } from '@mui/material';
import { displayZone, type Trip } from '../plan/trip';
import { formatClockWithZone } from '../time/zone';

const place = (label: string) => label.split(',')[0];

/** The one-line trip bar: "Dallas → Denver · Fri 08:00 CST · 36,000 lb · every 25 mi". */
export function TripSummary({ trip, onClick }: { trip: Trip; onClick(): void }) {
  const leaves = formatClockWithZone(trip.departureMs, displayZone(trip));
  return (
    <Button
      fullWidth
      onClick={onClick}
      aria-label="Edit trip"
      sx={{
        minHeight: 48,
        justifyContent: 'space-between',
        textAlign: 'left',
        color: 'text.primary',
        px: 2,
      }}
    >
      <Typography variant="body2" component="span" noWrap sx={{ fontWeight: 600, flex: 1 }}>
        {place(trip.origin.label)} → {place(trip.destination.label)} · {leaves} ·{' '}
        {trip.loadLb.toLocaleString('en-US')} lb · every {trip.spacing} mi
      </Typography>
      <Typography variant="body2" component="span" color="primary" sx={{ ml: 1, fontWeight: 600 }}>
        Edit
      </Typography>
    </Button>
  );
}
