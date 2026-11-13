import { Box, Button, Link, Stack, Typography } from '@mui/material';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Trip } from '../plan/trip';
import { AddressField } from './AddressField';
import { DepartureField } from './DepartureField';
import { LoadField } from './LoadField';
import { SpacingControl } from './SpacingControl';
import { validateTrip, type FormValues } from './validation';

interface Props {
  values: FormValues;
  onChange(values: FormValues): void;
  /** Called with a validated trip, or not at all. */
  onSubmit(trip: Trip): void;
}

export function TripForm({ values, onChange, onSubmit }: Props) {
  // The time of the first press of "Plan routes": from then on the form shows what is wrong.
  const [attemptedAt, setAttemptedAt] = useState<number | null>(null);
  const errors = attemptedAt === null ? {} : (validateTrip(values, attemptedAt).errors ?? {});

  // The credit callback is handed to effects in both address fields, so it must not change with
  // every keystroke; it reads the latest values from a ref that is current before any effect runs.
  const latest = useRef({ values, onChange });
  useLayoutEffect(() => {
    latest.current = { values, onChange };
  });
  const setCredit = useCallback((credit: FormValues['addressCredit']) => {
    const { values: current, onChange: change } = latest.current;
    if (credit && credit.text !== current.addressCredit?.text)
      change({ ...current, addressCredit: credit });
  }, []);

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const now = Date.now();
        setAttemptedAt(now);
        const result = validateTrip(values, now);
        if (result.trip) onSubmit(result.trip);
      }}
    >
      <Stack spacing={2.5}>
        <AddressField
          label="Starting place"
          text={values.originText}
          choice={values.origin}
          error={errors.origin}
          onCredit={setCredit}
          onChange={(originText, origin) => onChange({ ...values, originText, origin })}
        />
        <AddressField
          label="Destination"
          text={values.destinationText}
          choice={values.destination}
          error={errors.destination}
          onCredit={setCredit}
          onChange={(destinationText, destination) =>
            onChange({ ...values, destinationText, destination })
          }
        />
        <Box>
          <Button
            size="small"
            sx={{ minHeight: 44 }}
            onClick={() =>
              onChange({
                ...values,
                origin: values.destination,
                originText: values.destinationText,
                destination: values.origin,
                destinationText: values.originText,
              })
            }
          >
            Swap start and destination
          </Button>
        </Box>
        <DepartureField
          value={values.departure}
          zone={values.origin?.timezone ?? null}
          error={errors.departure}
          onChange={(departure) => onChange({ ...values, departure })}
        />
        <LoadField
          value={values.loadText}
          error={errors.load}
          onChange={(loadText) => onChange({ ...values, loadText })}
        />
        <SpacingControl
          value={values.spacing}
          onChange={(spacing) => onChange({ ...values, spacing })}
        />
        {values.addressCredit && (
          <Typography variant="caption" color="text.secondary">
            Address search:{' '}
            <Link href={values.addressCredit.url} target="_blank" rel="noopener noreferrer">
              {values.addressCredit.text}
            </Link>
          </Typography>
        )}
        <Box
          sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', py: 1.5, zIndex: 1 }}
        >
          <Button type="submit" variant="contained" size="large" fullWidth sx={{ minHeight: 52 }}>
            Plan routes
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}
