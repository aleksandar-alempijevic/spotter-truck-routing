import { Alert, AlertTitle, Button } from '@mui/material';
import type { ErrorMessage } from '../plan/errors';

/** An error in plain words with its one way forward. */
export function ErrorNotice({
  message,
  onRetry,
  onEdit,
}: {
  message: ErrorMessage;
  onRetry(): void;
  onEdit(): void;
}) {
  return (
    <Alert
      severity="error"
      action={
        message.action === 'retry' ? (
          <Button
            color="inherit"
            size="small"
            sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
            onClick={onRetry}
          >
            Try again
          </Button>
        ) : message.action === 'edit' ? (
          <Button
            color="inherit"
            size="small"
            sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
            onClick={onEdit}
          >
            Edit trip
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{message.title}</AlertTitle>
      {message.body}
    </Alert>
  );
}
