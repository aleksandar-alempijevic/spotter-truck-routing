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
    <Typography
      variant="caption"
      color="text.secondary"
      component="p"
      sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2 }}
    >
      {items.map(({ label, credit }) => (
        <span key={label}>
          {label}:{' '}
          <Link
            href={credit.url}
            target="_blank"
            rel="noopener noreferrer"
            // A 44 px tall target: the padding is vertical, so the text stays where it was.
            sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
          >
            {credit.text}
          </Link>
        </span>
      ))}
    </Typography>
  );
}
