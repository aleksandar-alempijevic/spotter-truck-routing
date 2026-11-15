import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import { formatMiles } from '../plan/format';
import {
  formatDifference,
  formatMeasure,
  STEP_NAME,
  type Criteria,
  type CriteriaRow,
  type Standing,
} from '../plan/explain';
import type { RouteView } from '../plan/view';

interface Props {
  criteria: Criteria;
  routes: readonly RouteView[];
}

/** One line about one route at one step, or null when the route was already out. */
function standingText(
  row: CriteriaRow,
  standing: Standing,
  winnerName: string,
  name: (id: string) => string,
): string | null {
  if (standing.kind === 'out') return null;
  if (standing.kind === 'tie') {
    const against =
      standing.difference === null
        ? ''
        : ` (${formatDifference(row.step, standing.difference)} against ${winnerName})`;
    return `Tie${against}`;
  }
  const { routeValue, bestValue, tolerance, againstId } = standing;
  const values =
    routeValue !== null && bestValue !== null
      ? `: ${formatMeasure(row.step, routeValue)} against ${formatMeasure(row.step, bestValue)}`
      : '';
  const allowed = tolerance > 0 ? `, tolerance ${formatMeasure(row.step, tolerance)}` : '';
  return `Left the contest, behind ${name(againstId)}${values}${allowed}`;
}

/**
 * The reasoning behind first place, behind an expand. Only first place is explained: the steps at
 * which second and third place left the contest are not ranked against each other.
 */
export function WhyThisRoute({ criteria, routes }: Props) {
  const name = (id: string) => routes.find((r) => r.id === id)?.name ?? id;
  const winner = name(criteria.firstId);

  return (
    <Accordion
      disableGutters
      variant="outlined"
      slotProps={{ transition: { unmountOnExit: true } }}
    >
      <AccordionSummary
        sx={{ minHeight: 48, fontWeight: 700 }}
        aria-controls="why-route"
        id="why-route-header"
      >
        Why this route?
      </AccordionSummary>
      <AccordionDetails id="why-route">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          The steps are applied in order, and the first step that leaves one route decides first
          place. Other routes are compared with {winner} only, not with each other.
        </Typography>
        <Stack component="ol" spacing={1.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {criteria.rows.map((row) => {
            const lines = row.standings
              .map(({ routeId, standing }) => ({
                routeId,
                text: standingText(row, standing, winner, name),
              }))
              .filter((l) => l.text !== null);
            const lost = row.standings
              .filter((s) => s.standing.kind === 'lost')
              .map((s) => name(s.routeId));
            const summary = [
              lost.length > 0 ? `ahead of ${lost.join(' and ')}` : null,
              row.tiedWith.length > 0 ? `tied with ${row.tiedWith.map(name).join(' and ')}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <Box
                component="li"
                key={row.step}
                sx={{
                  pl: 1.5,
                  borderLeft: 4,
                  borderColor: row.decides ? 'primary.main' : 'divider',
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {STEP_NAME[row.step]}
                  </Typography>
                  {row.decides && <Chip size="small" color="primary" label="Decides" />}
                  {!row.decides && row.tiedWith.length > 0 && (
                    <Chip size="small" variant="outlined" label="Tie" />
                  )}
                </Stack>
                <Typography variant="body2">
                  {winner}
                  {summary ? `: ${summary}` : ''}
                </Typography>
                {lines.map(({ routeId, text }) => (
                  <Typography key={routeId} variant="body2" color="text.secondary">
                    {name(routeId)}: {text}
                  </Typography>
                ))}
              </Box>
            );
          })}
        </Stack>
        {criteria.noForecast.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            {criteria.noForecast
              .map(
                ({ routeId, miles }) =>
                  `${name(routeId)} has no forecast for ${formatMiles(miles)}`,
              )
              .join('; ')}
            . Routes are compared on the part that has a forecast.
          </Typography>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
