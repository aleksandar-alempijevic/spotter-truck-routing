import { Alert, Button, CircularProgress } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from './api/health';

export function HealthStatus() {
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });

  if (isPending) return <CircularProgress aria-label="Checking the API" />;
  if (error) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" disabled={isFetching} onClick={() => refetch()}>
            Retry
          </Button>
        }
      >
        Cannot reach the API. Start the backend with <code>make backend</code>. ({error.message})
      </Alert>
    );
  }
  return <Alert severity="success">API status: {data.status}</Alert>;
}
