import { Container, Stack, Typography } from '@mui/material';
import { HealthStatus } from './HealthStatus';

export function App() {
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          Truck Route Safety
        </Typography>
        <HealthStatus />
      </Stack>
    </Container>
  );
}
