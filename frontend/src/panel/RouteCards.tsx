import { Box, ButtonBase, Chip, Stack, Typography } from '@mui/material';
import type { Trip } from '../plan/trip';
import type { RouteView } from '../plan/view';
import { HATCH_CSS, RISK_STYLE, LEVELS_BY_SEVERITY } from '../risk/levels';
import { RiskBadge } from '../risk/RiskBadge';
import { RiskGlyph } from '../risk/RiskGlyph';
import { formatDuration } from '../time/zone';
import { formatMiles } from '../plan/format';
import { selectableSx } from './selectable';
import { arrivalInDestinationZone, arrivalMs, originClock } from './times';

interface Props {
  routes: readonly RouteView[];
  trip: Trip;
  selectedId: string | null;
  recommendedId: string | null;
  onSelect(routeId: string): void;
}

/** Miles at each level as a bar and as text, so the bar never carries the meaning alone. */
function MilesByLevel({ route }: { route: RouteView }) {
  const weatherFailed = route.risk.kind === 'unavailable';
  const summary = route.summary;
  if (!summary) {
    // Holds the space the summary will take, so late weather shifts nothing.
    return (
      <Box sx={{ minHeight: 44 }}>
        <Box sx={{ height: 10, borderRadius: 1, bgcolor: 'action.hover' }} />
        <Typography variant="caption" color="text.secondary">
          {weatherFailed
            ? 'Risk along this route could not be loaded.'
            : 'Risk along the route appears when the weather is in.'}
        </Typography>
      </Box>
    );
  }
  const miles: Record<(typeof LEVELS_BY_SEVERITY)[number], number> = {
    low: summary.low_miles,
    moderate: summary.moderate_miles,
    high: summary.high_miles,
    severe: summary.severe_miles,
    no_travel: summary.no_travel_miles,
  };
  const total = route.miles || 1;
  return (
    <Box sx={{ minHeight: 44 }}>
      <Box
        sx={{
          display: 'flex',
          height: 10,
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'action.hover',
        }}
      >
        {LEVELS_BY_SEVERITY.map((level) =>
          miles[level] > 0 ? (
            <Box
              key={level}
              sx={{ width: `${(miles[level] / total) * 100}%`, bgcolor: RISK_STYLE[level].color }}
            />
          ) : null,
        )}
        {summary.no_forecast_miles > 0 && (
          <Box
            sx={{
              width: `${(summary.no_forecast_miles / total) * 100}%`,
              background: HATCH_CSS,
            }}
          />
        )}
      </Box>
      <Typography variant="caption" component="div" sx={{ mt: 0.5, lineHeight: 1.5 }}>
        {LEVELS_BY_SEVERITY.filter((level) => miles[level] > 0).map((level, i) => (
          <span key={level}>
            {i > 0 ? ' · ' : ''}
            {RISK_STYLE[level].label} {formatMiles(miles[level])}
          </span>
        ))}
        {summary.no_forecast_miles > 0 && (
          <span>
            {' · '}No forecast {formatMiles(summary.no_forecast_miles)}
          </span>
        )}
      </Typography>
    </Box>
  );
}

/** One card per route: time, distance, arrival and the miles at each level. */
export function RouteCards({ routes, trip, selectedId, recommendedId, onSelect }: Props) {
  return (
    <Stack spacing={1.5} component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {routes.map((route) => {
        const selected = route.id === selectedId;
        const arrival = arrivalMs(route);
        const inDestination = arrivalInDestinationZone(trip, arrival);
        return (
          <li key={route.id}>
            <ButtonBase
              aria-pressed={selected}
              onClick={() => onSelect(route.id)}
              sx={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                p: 1.5,
                borderRadius: 2,
                ...selectableSx(selected),
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
              >
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {route.name}
                  {route.via ? ` via ${route.via}` : ''}
                </Typography>
                {route.id === recommendedId && (
                  <Chip size="small" color="primary" label="Recommended" />
                )}
                {route.isFastest && <Chip size="small" variant="outlined" label="Fastest" />}
                <Box sx={{ flex: 1 }} />
                <RiskBadge state={route.risk} />
              </Stack>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {formatDuration(route.travelSeconds)} · {formatMiles(route.miles)}
                {route.rank !== null ? ` · ranked ${route.rank}` : ''}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Arrives {originClock(trip, arrival)}
                {inDestination ? ` (${inDestination} there)` : ''}
              </Typography>
              <MilesByLevel route={route} />
              {route.summary && route.summary.no_travel_miles > 0 && (
                <Box
                  role="note"
                  sx={{
                    mt: 1,
                    px: 1,
                    py: 0.5,
                    borderRadius: 1,
                    bgcolor: RISK_STYLE.no_travel.color,
                    color: RISK_STYLE.no_travel.onColor,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    fontWeight: 700,
                  }}
                >
                  <Box
                    sx={{ display: 'inline-flex', bgcolor: '#fff', borderRadius: '50%', p: 0.25 }}
                  >
                    <RiskGlyph risk="no_travel" size={18} />
                  </Box>
                  No Travel on {formatMiles(route.summary.no_travel_miles)} of this route
                </Box>
              )}
            </ButtonBase>
          </li>
        );
      })}
    </Stack>
  );
}
