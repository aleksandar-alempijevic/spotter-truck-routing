/** The border and fill of a route chip or card, so the two read as the same selectable thing. */
export const selectableSx = (selected: boolean) =>
  ({
    border: 2,
    borderColor: selected ? 'primary.main' : 'divider',
    bgcolor: selected ? 'action.selected' : 'background.paper',
  }) as const;
