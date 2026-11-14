import { LinearProgress, Stack, Typography } from '@mui/material';
import { HOST_SLEEPS, WAKE_NOTICE } from '../hosting';
import { useElapsed } from './useElapsed';

/** Routes normally answer within about 15 s, so a longer wait is when the host may be waking. */
export const WAKE_NOTICE_AFTER_S = 15;

interface Props {
  stage: 'routes' | 'weather';
  sinceMs: number;
  /** Known once the routes land. */
  checkpointCount?: number;
  /** Spacing and length make the weather wait long. */
  longWait?: boolean;
  /** Whether the host sleeps when idle; the hosted build sets it. */
  hostSleeps?: boolean;
}

/**
 * Named stages and elapsed time, no percentage: neither endpoint reports progress, so a bar or a
 * countdown would be invented precision.
 */
export function WaitStatus({
  stage,
  sinceMs,
  checkpointCount,
  longWait,
  hostSleeps = HOST_SLEEPS,
}: Props) {
  const seconds = useElapsed(sinceMs);
  const routesStage = stage === 'routes';
  return (
    <Stack spacing={1} role="status" aria-live="polite">
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
        {routesStage ? 'Finding truck routes' : 'Routes found. Checking the weather'}
      </Typography>
      <LinearProgress />
      <Typography variant="body2" color="text.secondary">
        {routesStage
          ? `Working for ${seconds} s. Long trips can take up to 30 s.`
          : `Reading the forecast at ${checkpointCount ?? 'each'} points along the routes. Working for ${seconds} s.`}
      </Typography>
      {routesStage && hostSleeps && seconds >= WAKE_NOTICE_AFTER_S && (
        <Typography variant="body2" color="text.secondary">
          {WAKE_NOTICE}
        </Typography>
      )}
      {!routesStage && longWait && (
        <Typography variant="body2" color="text.secondary">
          A short checkpoint spacing on a long trip can take about a minute.
        </Typography>
      )}
    </Stack>
  );
}
