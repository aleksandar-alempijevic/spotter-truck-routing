import { Box } from '@mui/material';
import { RiskGlyph } from './RiskGlyph';
import { riskKey, riskLabel, type RiskState } from './levels';

/** Glyph and label together: a level never relies on colour alone. */
export function RiskBadge({ state, pendingLabel }: { state: RiskState; pendingLabel?: string }) {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontWeight: 600 }}
    >
      <RiskGlyph risk={riskKey(state)} />
      {state.kind === 'pending' && pendingLabel ? pendingLabel : riskLabel(state)}
    </Box>
  );
}
