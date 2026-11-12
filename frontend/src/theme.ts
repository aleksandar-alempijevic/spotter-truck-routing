import { createTheme } from '@mui/material';

// Light (the default) and dark colour schemes; MUI picks one from the system setting.
export const theme = createTheme({
  colorSchemes: { dark: true },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
});
