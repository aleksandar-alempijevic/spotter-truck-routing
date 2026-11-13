import { Autocomplete, Box, TextField } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from '../api/client';
import { fetchAddresses } from '../api/endpoints';
import type { AttributionOut, SuggestionOut } from '../api/types';
import { describeError } from '../plan/errors';
import { canSearch, SEARCH_MAX_CHARS } from './validation';
import { useDebouncedValue } from './useDebouncedValue';

export const SEARCH_DEBOUNCE_MS = 350;

interface Props {
  label: string;
  text: string;
  choice: SuggestionOut | null;
  /** Typing clears the choice; picking a suggestion sets both. */
  onChange(text: string, choice: SuggestionOut | null): void;
  onCredit(credit: AttributionOut): void;
  error?: string;
}

/**
 * Address search: debounced, never sent below 3 or above 100 characters, with superseded searches
 * cancelled. What the driver picks is a whole suggestion (label, position, time zone).
 */
export function AddressField({ label, text, choice, onChange, onCredit, error }: Props) {
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
  const failure = query.error
    ? describeError(
        'address',
        query.error instanceof ApiError ? query.error : new ApiError('unknown', '', 0),
      )
    : null;
  const shortText = text.trim().length > 0 && text.trim().length < 3;

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
      noOptionsText={
        searching && !query.isFetching ? 'No matching place' : 'Type at least 3 characters'
      }
      slotProps={{ listbox: { sx: { '& .MuiAutocomplete-option': { minHeight: 48 } } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          error={Boolean(error) || failure !== null}
          helperText={
            error ??
            (failure
              ? `${failure.title}. ${failure.body}`
              : shortText
                ? 'Type at least 3 characters'
                : choice
                  ? ' '
                  : 'City, address or place, with the state')
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
