import { Link, Typography } from '@mui/material';
import type { AttributionOut } from '../api/types';

/** The credits the answers carry. The basemap's own comes from the map's attribution control. */
export function Credits({
  weather,
  address,
}: {
  weather: AttributionOut | undefined;
  address: AttributionOut | null;
}) {
  const items = [
    weather ? { label: 'Weather', credit: weather } : null,
    address ? { label: 'Address search', credit: address } : null,
  ].filter((item) => item !== null);
  if (items.length === 0) return null;
  return (
    <Typography variant="caption" color="text.secondary" component="p">
      {items.map(({ label, credit }, i) => (
        <span key={label}>
          {i > 0 ? ' · ' : ''}
          {label}:{' '}
          <Link href={credit.url} target="_blank" rel="noopener noreferrer">
            {credit.text}
          </Link>
        </span>
      ))}
    </Typography>
  );
}
