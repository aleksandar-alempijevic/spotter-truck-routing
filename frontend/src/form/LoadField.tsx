import { TextField } from '@mui/material';
import { MAX_LOAD_LB } from '../plan/trip';

/** Cargo weight in pounds: a text field with a numeric keypad, since a number input drops bad text silently. */
export function LoadField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange(value: string): void;
  error?: string;
}) {
  return (
    <TextField
      label="Cargo weight (lb)"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={Boolean(error)}
      helperText={error}
      placeholder={`Up to ${MAX_LOAD_LB.toLocaleString('en-US')} lb`}
      slotProps={{
        htmlInput: { inputMode: 'numeric', autoComplete: 'off', enterKeyHint: 'done' },
      }}
    />
  );
}
