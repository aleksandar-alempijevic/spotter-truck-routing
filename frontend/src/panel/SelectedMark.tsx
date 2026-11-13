import { Box } from '@mui/material';

/** A check mark in a circle on the selected route's chip or card. Decorative: the button says it is pressed. */
export function SelectedMark() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      sx={{ width: 18, height: 18, flexShrink: 0, color: 'primary.main' }}
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="M6.5 12.5l3.5 3.5l7.5-8"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Box>
  );
}
