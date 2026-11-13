import type { Theme } from '@mui/material';

/**
 * The border and fill of a route chip or card, so the two read as the same selectable thing. The
 * selected one has a thicker border (an inset ring, so nothing shifts) and a check mark from
 * `SelectedMark`: it never relies on the colour of the border alone.
 */
export const selectableSx = (selected: boolean) =>
  ({
    border: 2,
    borderColor: selected ? 'primary.main' : 'divider',
    boxShadow: selected
      ? (theme: Theme) => `inset 0 0 0 2px ${theme.palette.primary.main}`
      : 'none',
    bgcolor: selected ? 'action.selected' : 'background.paper',
  }) as const;
