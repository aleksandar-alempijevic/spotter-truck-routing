import { LinearProgress, Stack, Typography } from '@mui/material';
import { useWakeNotice } from '../hosting';
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
}

/**
 * Named stages and elapsed time, no percentage: neither endpoint reports progress, so a bar or a
 * countdown would be invented precision.
 */
export function WaitStatus({ stage, sinceMs, checkpointCount, longWait }: Props) {
  const seconds = useElapsed(sinceMs);
  const routesStage = stage === 'routes';
  const wakeNotice = useWakeNotice(routesStage, WAKE_NOTICE_AFTER_S * 1000);
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
      {wakeNotice && (
        <Typography variant="body2" color="text.secondary">
          {wakeNotice}
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
