import { createTheme } from '@mui/material';

// One light scheme: the risk palette is checked once, against the one light basemap, for a phone
// read in daylight.
export const theme = createTheme({
  components: {
    // The page never scrolls: a drag that runs out of the sheet must not pull it to refresh.
    MuiCssBaseline: { styleOverrides: { 'html, body': { overscrollBehavior: 'none' } } },
  },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
});
