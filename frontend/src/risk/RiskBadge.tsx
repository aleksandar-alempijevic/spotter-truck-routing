import { Box } from '@mui/material';
import { RiskGlyph } from './RiskGlyph';
import { riskKey, riskLabel, type RiskState } from './levels';
import { useWeatherFailed, WEATHER_UNAVAILABLE } from './weatherFailed';

/** Glyph and label together: a level never relies on colour alone. */
export function RiskBadge({ state }: { state: RiskState }) {
  const failed = useWeatherFailed();
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontWeight: 600 }}
    >
      <RiskGlyph risk={riskKey(state)} />
      {state.kind === 'pending' && failed ? WEATHER_UNAVAILABLE : riskLabel(state)}
    </Box>
  );
}
