import { Autocomplete, Box, Button, TextField } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { asApiError } from '../api/client';
import { fetchAddresses } from '../api/endpoints';
import type { AttributionOut, SuggestionOut } from '../api/types';
import { describeError } from '../plan/errors';
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '../plan/trip';
import { canSearch, tooShortToSearch } from './validation';
import { useDebouncedValue } from './useDebouncedValue';

const SEARCH_DEBOUNCE_MS = 350;
const TOO_SHORT_HINT = `Type at least ${SEARCH_MIN_CHARS} characters`;

/** A search that starts with a number and names no place is slow on the server. */
const NUMBER_HINT = 'Add the city for faster results';
const startsWithNumber = (text: string) => /^\s*\d/.test(text);

interface Props {
  label: string;
  text: string;
  choice: SuggestionOut | null;
  /** Typing clears the choice; picking a suggestion sets both. */
  onChange(text: string, choice: SuggestionOut | null): void;
  onCredit(credit: AttributionOut): void;
  error?: string;
  autoFocus?: boolean;
}

/**
 * Address search: debounced, never sent below the minimum or above the maximum length, with superseded searches
 * cancelled. What the driver picks is a whole suggestion (label, position, time zone).
 */
export function AddressField({ label, text, choice, onChange, onCredit, error, autoFocus }: Props) {
  const debounced = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const searching = choice === null && canSearch(debounced);

  const query = useQuery({
    queryKey: ['address', debounced],
    queryFn: ({ signal }) => fetchAddresses(debounced, signal),
    enabled: searching,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const credit = query.data?.attribution;
  useEffect(() => {
    if (credit) onCredit(credit);
  }, [credit, onCredit]);

  const options = searching ? (query.data?.suggestions ?? []) : [];
  const apiError = asApiError(query.error);
  const failure = apiError && describeError('address', apiError);
  const shortText = tooShortToSearch(text);

  return (
    <Autocomplete
      options={options}
      value={choice}
      inputValue={text}
      filterOptions={(all) => all}
      loading={query.isFetching && searching}
      getOptionLabel={(s) => s.label}
      isOptionEqualToValue={(a, b) => a.label === b.label && a.lat === b.lat && a.lon === b.lon}
      onInputChange={(_, value, reason) => {
        // 'reset' is MUI echoing a chosen value back; only the driver's own edits count.
        if (reason === 'input' || reason === 'clear') onChange(value, null);
      }}
      onChange={(_, picked) => {
        if (picked) onChange(picked.label, picked);
      }}
      noOptionsText={searching && !query.isFetching ? 'No matching place' : TOO_SHORT_HINT}
      slotProps={{ listbox: { sx: { '& .MuiAutocomplete-option': { minHeight: 48 } } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          autoFocus={autoFocus}
          error={Boolean(error) || failure !== null}
          helperText={
            error ??
            (failure ? (
              <>
                {failure.title}. {failure.body}{' '}
                {failure.action === 'retry' && (
                  <Button size="small" sx={{ minHeight: 44 }} onClick={() => void query.refetch()}>
                    Try again
                  </Button>
                )}
              </>
            ) : shortText ? (
              TOO_SHORT_HINT
            ) : searching && startsWithNumber(text) ? (
              NUMBER_HINT
            ) : choice ? (
              ' '
            ) : (
              'City, address or place, with the state'
            ))
          }
          slotProps={{
            ...params.slotProps,
            htmlInput: {
              ...params.slotProps.htmlInput,
              maxLength: SEARCH_MAX_CHARS,
              autoCorrect: 'off',
              autoCapitalize: 'off',
              spellCheck: false,
              enterKeyHint: 'search',
            },
          }}
        />
      )}
      renderOption={(props, option) => {
        const { key, ...rest } = props as typeof props & { key: string };
        return (
          <Box component="li" key={key} {...rest}>
            {option.label}
          </Box>
        );
      }}
    />
  );
}
