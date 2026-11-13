import { Box, Button, ButtonBase, Paper } from '@mui/material';
import type { ReactNode } from 'react';

/** Three heights, changed by buttons or by tapping the handle. No drag, no modal, no backdrop. */
export type SheetState = 'peek' | 'half' | 'full';

const ORDER: readonly SheetState[] = ['peek', 'half', 'full'];

interface Props {
  state: SheetState;
  onState(state: SheetState): void;
  /** Height of whatever sits above the sheet at full height, such as the trip bar. */
  topClearance: number;
  children: ReactNode;
}

/**
 * A nonmodal bottom sheet. The map behind it keeps every gesture because nothing covers it but
 * the sheet itself. Its scrolling content is separate from the handle row.
 */
export function Sheet({ state, onState, topClearance, children }: Props) {
  const at = ORDER.indexOf(state);
  const height = {
    peek: 'auto',
    half: '50dvh',
    full: `calc(100dvh - ${topClearance}px)`,
  }[state];

  return (
    <Paper
      elevation={8}
      component="section"
      aria-label="Routes and weather"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height,
        maxHeight: state === 'peek' ? '45dvh' : undefined,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        overflow: 'hidden',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, pl: 1, pr: 0.5 }}>
        <ButtonBase
          aria-label={state === 'full' ? 'Collapse the results' : 'Expand the results'}
          onClick={() => onState(ORDER[(at + 1) % ORDER.length])}
          sx={{ flex: 1, height: 44 }}
        >
          <Box sx={{ width: 40, height: 5, borderRadius: 3, bgcolor: 'action.disabled' }} />
        </ButtonBase>
        <Button
          size="small"
          sx={{ minHeight: 44, minWidth: 64 }}
          disabled={at === 0}
          onClick={() => onState(ORDER[at - 1])}
        >
          Less
        </Button>
        <Button
          size="small"
          sx={{ minHeight: 44, minWidth: 64 }}
          disabled={at === ORDER.length - 1}
          onClick={() => onState(ORDER[at + 1])}
        >
          More
        </Button>
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          px: 2,
          pb: 'calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        {children}
      </Box>
    </Paper>
  );
}
