import { Box, Button, Paper, Typography } from '@mui/material';
import { CELL_ALPHA, LEVELS_BY_SEVERITY, RISK_STYLE } from '../risk/levels';

const SWATCH = 18;

/** A swatch as the cell looks on the map: the level's colour at the map's opacity. */
function cellSwatch(color: string, alpha: number): string {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

interface Props {
  open: boolean;
  onToggle(): void;
  /** Where the legend sits, in px from the top and left of the screen. */
  top: number;
  left: number;
}

/**
 * The key to the heatmap: what each colour of a cell means, and the hatch for "no forecast".
 * It is a toggle, so on a phone it can be out of the way. Every row is a swatch and a word.
 */
export function Legend({ open, onToggle, top, left }: Props) {
  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        zIndex: 2,
        top: `calc(${top}px + 8px)`,
        left: `calc(${left}px + 8px)`,
        maxWidth: 220,
      }}
    >
      <Button
        aria-expanded={open}
        aria-controls="map-legend"
        onClick={onToggle}
        sx={{ minHeight: 44, minWidth: 44, px: 1.5, color: 'text.primary', fontWeight: 700 }}
      >
        {open ? 'Hide key' : 'Map key'}
      </Button>
      {open && (
        <Box id="map-legend" component="ul" sx={{ listStyle: 'none', m: 0, px: 1.5, pb: 1.5 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            component="li"
            sx={{ display: 'block', mb: 0.5 }}
          >
            Colour on the map at the hour chosen below. Tap a cell to read it.
          </Typography>
          {LEVELS_BY_SEVERITY.map((level) => (
            <Row
              key={level}
              label={RISK_STYLE[level].label}
              background={cellSwatch(
                RISK_STYLE[level].color,
                level === 'low' ? CELL_ALPHA.low : CELL_ALPHA.other,
              )}
            />
          ))}
          <Row
            label={RISK_STYLE.none.label}
            background={`repeating-linear-gradient(45deg, ${RISK_STYLE.none.color} 0 2px, #eceff1 2px 5px)`}
          />
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
