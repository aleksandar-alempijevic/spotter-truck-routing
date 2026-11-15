import { Box, ButtonBase, Typography } from '@mui/material';
import { describeRouteGust } from '../plan/describe';
import type { RouteView } from '../plan/view';
import { RiskBadge } from '../risk/RiskBadge';
import { formatDuration } from '../time/zone';
import { GustWarning } from './GustWarning';
import { Quantities } from './Quantities';
import { selectableSx } from './selectable';
import { SelectedMark } from './SelectedMark';

interface Props {
  routes: readonly RouteView[];
  selectedId: string | null;
  recommendedId: string | null;
  onSelect(routeId: string): void;
}

/** The peek tier's route switcher: name, time and worst level, one tap each. */
export function RouteChips({ routes, selectedId, recommendedId, onSelect }: Props) {
  return (
    <Box
      role="group"
      aria-label="Routes"
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(${routes.length}, minmax(0, 1fr))`,
        gap: 1,
      }}
    >
      {routes.map((route) => {
        const selected = route.id === selectedId;
        const gust = describeRouteGust(route.gustMph);
        return (
          <ButtonBase
            key={route.id}
            aria-pressed={selected}
            onClick={() => onSelect(route.id)}
            sx={{
              minHeight: 72,
              p: 1,
              borderRadius: 2,
              ...selectableSx(selected),
              flexDirection: 'column',
              alignItems: 'flex-start',
              justifyContent: 'center',
              textAlign: 'left',
              gap: 0.25,
            }}
          >
            <Typography
              variant="body2"
              component="span"
              sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 0.5 }}
            >
              {selected && <SelectedMark />}
              {route.name}
              {route.id === recommendedId ? ' ★' : ''}
            </Typography>
            <Typography variant="body2" component="span">
              <Quantities text={formatDuration(route.travelSeconds)} />
            </Typography>
            <Typography variant="caption" component="span" sx={{ lineHeight: 1.2 }}>
              <RiskBadge state={route.risk} />
            </Typography>
            {gust && <GustWarning text={gust.chip} size="small" />}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
