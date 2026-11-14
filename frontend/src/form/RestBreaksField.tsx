import { FormControlLabel, FormHelperText, Stack, Switch } from '@mui/material';

import { BREAKS_HELP } from '../plan/breaksCopy';

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
        {BREAKS_HELP}
      </FormHelperText>
    </Stack>
  );
}
