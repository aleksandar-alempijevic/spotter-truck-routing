import { TextField } from '@mui/material';

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
      helperText={error ?? 'Up to 80,000 lb'}
      slotProps={{
        htmlInput: { inputMode: 'numeric', autoComplete: 'off', enterKeyHint: 'done' },
      }}
    />
  );
}
