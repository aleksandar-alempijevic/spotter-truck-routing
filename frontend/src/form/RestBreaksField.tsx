import { FormControlLabel, FormHelperText, Stack, Switch } from '@mui/material';

/** What the switch adds, and what it assumes: said beside the switch, not behind a link. */
const HELP =
  'Adds a 30-minute break after 8 hours of driving and 10 hours off after 11. Assumes a rested start and no time except driving.';

export function RestBreaksField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <Stack spacing={0}>
      <FormControlLabel
        label="Include required rest breaks"
        sx={{ minHeight: 48, mx: 0, justifyContent: 'space-between', flexDirection: 'row-reverse' }}
        slotProps={{ typography: { variant: 'body2', sx: { fontWeight: 600 } } }}
        control={
          <Switch
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            slotProps={{ input: { 'aria-describedby': 'rest-breaks-help' } }}
          />
        }
      />
      <FormHelperText id="rest-breaks-help" sx={{ mx: 0 }}>
        {HELP}
      </FormHelperText>
    </Stack>
  );
}
