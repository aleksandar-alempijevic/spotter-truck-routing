import { createTheme } from '@mui/material';

// One light scheme: the risk palette is checked once, against the one light basemap, for a phone
// read in daylight.
export const theme = createTheme({
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
});
