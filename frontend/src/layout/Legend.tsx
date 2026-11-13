import { Box, Button, Paper, Typography } from '@mui/material';
import { cellFill, HATCH_CSS, LEVELS_BY_SEVERITY, RISK_STYLE } from '../risk/levels';

const SWATCH = 18;

interface Props {
  open: boolean;
  onToggle(): void;
}

/**
 * The key to the heatmap: what each colour of a cell means, and the hatch for "no forecast".
 * It is a toggle, so on a phone it can be out of the way. Every row is a swatch and a word.
 */
export function Legend({ open, onToggle }: Props) {
  return (
    <Paper
      elevation={3}
      sx={{ maxWidth: 220, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Button
        aria-expanded={open}
        aria-controls="map-legend"
        onClick={onToggle}
        sx={{
          minHeight: 44,
          minWidth: 44,
          px: 1.5,
          flexShrink: 0,
          color: 'text.primary',
          fontWeight: 700,
        }}
      >
        {open ? 'Hide key' : 'Map key'}
      </Button>
      {open && (
        // The room the corner leaves it: a short map scrolls the rows instead of hiding them.
        <Box
          id="map-legend"
          component="ul"
          sx={{ listStyle: 'none', m: 0, px: 1.5, pb: 1.5, minHeight: 0, overflowY: 'auto' }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            component="li"
            sx={{ display: 'block', mb: 0.5 }}
          >
            Colour on the map at the hour chosen below. Tap a cell to read it.
          </Typography>
          {LEVELS_BY_SEVERITY.map((level) => (
            <Row key={level} label={RISK_STYLE[level].label} background={cellFill(level)} />
          ))}
          <Row label={RISK_STYLE.none.label} background={HATCH_CSS} />
        </Box>
      )}
    </Paper>
  );
}

function Row({ label, background }: { label: string; background: string }) {
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 28 }}>
      <Box
        aria-hidden
        sx={{
          width: SWATCH,
          height: SWATCH,
          flexShrink: 0,
          borderRadius: 0.5,
          border: 1,
          borderColor: 'text.secondary',
          background,
        }}
      />
      <Typography variant="body2">{label}</Typography>
    </Box>
  );
}
