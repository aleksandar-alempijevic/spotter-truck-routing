import { Alert, Stack, Typography } from '@mui/material';
import { describeError } from '../plan/errors';
import { describe } from '../plan/explain';
import type { PlanState } from '../plan/queries';
import type { Submission } from '../plan/trip';
import { ErrorNotice } from './ErrorNotice';
import { WaitStatus } from './WaitStatus';

interface Props {
  state: PlanState;
  submission: Submission;
  onEditTrip(): void;
}

/** The first thing in the sheet or pane: the wait, the error, or the recommendation. */
export function PlanHeadline({ state, submission, onEditTrip }: Props) {
  const { phase, view, explanation } = state;

  if (phase === 'routes_pending' || phase === 'idle') {
    return <WaitStatus stage="routes" sinceMs={submission.startedAt} />;
  }
  if (phase === 'routes_error' && state.routesError) {
    return (
      <ErrorNotice
        message={describeError('routes', state.routesError)}
        onRetry={state.retryRoutes}
        onEdit={onEditTrip}
      />
    );
  }
  const routes = view?.routes ?? [];
  if (phase === 'weather_pending') {
    const points = routes.reduce((sum, r) => sum + r.checkpoints.length, 0);
    const longWait = submission.trip.spacing === 10 && routes.some((r) => r.miles > 500);
    return (
      <WaitStatus
        stage="weather"
        sinceMs={state.routesAt}
        checkpointCount={points}
        longWait={longWait}
      />
    );
  }
  if (phase === 'weather_error' && state.weatherError) {
    return (
      <Stack spacing={1}>
        <ErrorNotice
          message={describeError('weather', state.weatherError)}
          onRetry={state.retryWeather}
          onEdit={onEditTrip}
        />
        <Typography variant="body2" color="text.secondary">
          The routes are shown without their weather risk.
        </Typography>
      </Stack>
    );
  }
  if (!explanation) return null;
  const { headline, reason, cost } = describe(explanation, routes);
  return (
    <Stack spacing={0.5}>
      <Typography variant="h6" component="h2" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
        {headline}
      </Typography>
      {reason && <Typography variant="body1">{reason}</Typography>}
      {cost && (
        <Typography variant="body2" color="text.secondary">
          {cost}
        </Typography>
      )}
      {explanation.kind === 'none_safe' && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Every route has miles where travel is not advised. Consider waiting, using the slider to
          find a better hour.
        </Alert>
      )}
    </Stack>
  );
}
