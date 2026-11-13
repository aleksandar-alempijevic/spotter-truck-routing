import { Alert, AlertTitle, Box, Button } from '@mui/material';

/** What stands in for the whole page if it throws while rendering: nothing else is left to show. */
export function CrashNotice() {
  return (
    <Box sx={{ p: 2, maxWidth: 480, mx: 'auto', mt: 4 }}>
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        }
      >
        <AlertTitle>Something went wrong</AlertTitle>
        The page stopped working. Reload it and plan the trip again.
      </Alert>
    </Box>
  );
}
