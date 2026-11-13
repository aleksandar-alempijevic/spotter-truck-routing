import { Box, Divider, Stack, Typography } from '@mui/material';
import type { CheckpointRef } from '../plan/view';
import type { PlanState } from '../plan/queries';
import type { Submission } from '../plan/trip';
import { Credits } from './Credits';
import { CheckpointList, CheckpointRow } from './CheckpointList';
import { PlanHeadline } from './PlanHeadline';
import { RouteCards } from './RouteCards';
import { RouteChips } from './RouteChips';
import { WhyThisRoute } from './WhyThisRoute';

/**
 * Which parts of the panel are shown: the sheet shows one tier at a time, the pane all of them in
 * one column, and `wide` all of them in two (the routes, then the checkpoints beside them).
 */
export type PanelTier = 'peek' | 'half' | 'full' | 'all' | 'wide';

interface Props {
  tier: PanelTier;
  state: PlanState;
  submission: Submission;
  selectedRouteId: string | null;
  selectedCheckpoint: CheckpointRef | null;
  onSelectRoute(routeId: string): void;
  onSelectCheckpoint(ref: CheckpointRef): void;
  onEditTrip(): void;
}

/** What the sheet or pane shows. It is indifferent to which of the two holds it. */
export function PlanPanel({
  tier: shown,
  state,
  submission,
  selectedRouteId,
  selectedCheckpoint,
  onSelectRoute,
  onSelectCheckpoint,
  onEditTrip,
}: Props) {
  const tier = shown === 'wide' ? 'all' : shown;
  const routes = state.view?.routes ?? [];
  const recommendedId = state.view?.ranking?.recommended_id ?? null;
  const selected = routes.find((r) => r.id === selectedRouteId) ?? null;
  const weatherFailed = state.phase === 'weather_error';
  const showChips = routes.length > 0 && (tier === 'peek' || tier === 'full');
  const showCards = routes.length > 0 && (tier === 'half' || tier === 'all');
  const detailCp =
    selected && selectedCheckpoint?.routeId === selected.id
      ? selected.checkpoints[selectedCheckpoint.index]
      : undefined;
  const showList = selected !== null && (tier === 'full' || tier === 'all');

  const list = showList && (
    <CheckpointList
      route={selected}
      trip={submission.trip}
      selected={selectedCheckpoint}
      onSelect={onSelectCheckpoint}
      weatherFailed={weatherFailed}
    />
  );

  const routesColumn = (
    <Stack spacing={2}>
      <PlanHeadline state={state} submission={submission} onEditTrip={onEditTrip} />
      {state.view?.shortfall && (tier === 'half' || tier === 'all') && (
        <Typography variant="body2" color="text.secondary">
          {state.view.shortfall}
        </Typography>
      )}
      {state.explanation &&
        'criteria' in state.explanation &&
        state.explanation.criteria &&
        tier !== 'peek' && <WhyThisRoute criteria={state.explanation.criteria} routes={routes} />}
      {showChips && (
        <RouteChips
          routes={routes}
          selectedId={selectedRouteId}
          recommendedId={recommendedId}
          weatherFailed={weatherFailed}
          onSelect={onSelectRoute}
        />
      )}
      {showCards && (
        <RouteCards
          routes={routes}
          trip={submission.trip}
          selectedId={selectedRouteId}
          recommendedId={recommendedId}
          weatherFailed={weatherFailed}
          onSelect={onSelectRoute}
        />
      )}
      {tier === 'half' && selected && detailCp && (
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Selected checkpoint on {selected.name}
          </Typography>
          <CheckpointRow
            route={selected}
            cp={detailCp}
            trip={submission.trip}
            isSelected
            onSelect={onSelectCheckpoint}
            weatherFailed={weatherFailed}
          />
        </Box>
      )}
      {shown !== 'wide' && list && (
        <>
          <Divider />
          {list}
        </>
      )}
      {(tier === 'half' || tier === 'full' || tier === 'all') && (
        <Box>
          <Credits weather={state.weather?.attribution} address={submission.trip.addressCredit} />
        </Box>
      )}
    </Stack>
  );

  if (shown !== 'wide') return routesColumn;
  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr)', columnGap: 3 }}
    >
      {routesColumn}
      <Box>{list}</Box>
    </Box>
  );
}
