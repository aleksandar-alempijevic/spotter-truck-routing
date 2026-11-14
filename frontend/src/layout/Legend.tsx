import { Box, Button, Paper, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { StopMark } from '../risk/StopMark';
import { cellFill, HATCH_CSS, LEVELS_BY_SEVERITY, RISK_STYLE } from '../risk/levels';

const SWATCH = 18;
/** Drawn at the map's proportions, so a little larger than a swatch to keep the badge legible. */
const STOP_KEY_SIZE = 30;

interface Props {
  open: boolean;
  /** The plan has required stops, so the key says what their mark is. */
  hasStops: boolean;
  onToggle(): void;
}

/**
 * The key to the heatmap: what each colour of a cell means, and the hatch for "no forecast".
 * It is a toggle, so on a phone it can be out of the way. Every row is a swatch and a word.
 */
export function Legend({ open, hasStops, onToggle }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState({ scrolls: false, moreBelow: false });

  // On a short map the rows scroll; a fade and a word at the foot say there are more below.
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) {
      setScroll({ scrolls: false, moreBelow: false });
      return;
    }
    const read = () =>
      setScroll({
        scrolls: list.scrollHeight > list.clientHeight + 1,
        moreBelow: list.scrollHeight - list.scrollTop - list.clientHeight > 2,
      });
    read();
    list.addEventListener('scroll', read);
    const observer = new ResizeObserver(read);
    observer.observe(list);
    return () => {
      list.removeEventListener('scroll', read);
      observer.disconnect();
    };
  }, [open]);

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'relative',
        maxWidth: 220,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
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
          ref={listRef}
          id="map-legend"
          component="ul"
          // A list that scrolls is a tab stop, so a keyboard can reach the rows below.
          tabIndex={scroll.scrolls ? 0 : undefined}
          aria-label={scroll.scrolls ? 'Map key, scrolls' : undefined}
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
          {hasStops && <StopRow />}
        </Box>
      )}
      {open && scroll.moreBelow && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 32,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            pb: 0.25,
            borderRadius: 1,
            pointerEvents: 'none',
            background: 'linear-gradient(to bottom, rgba(255,255,255,0), #fff 70%)',
            fontSize: 12,
            fontWeight: 700,
            color: 'text.secondary',
          }}
        >
          More ▾
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

/** The required-stop mark as the map draws it, and what its corner badge says. */
function StopRow() {
  return (
    <Box
      component="li"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 28, mt: 0.5 }}
    >
      <Box sx={{ display: 'inline-flex', flexShrink: 0 }}>
        <StopMark risk="low" size={STOP_KEY_SIZE} />
      </Box>
      <Typography variant="body2">
        Required stop; the corner badge is the weather level there
      </Typography>
    </Box>
  );
}
