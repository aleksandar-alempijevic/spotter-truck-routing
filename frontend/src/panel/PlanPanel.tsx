import { Box, Divider, Stack, Typography } from '@mui/material';
import type { Ref } from 'react';
import type { CheckpointRef } from '../plan/view';
import type { PlanState } from '../plan/queries';
import { placeName, type Submission } from '../plan/trip';
import { visuallyHidden } from '../visuallyHidden';
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

/**
 * What each tier shows, stated once. The headline, the shortfall note and the credits are in every
 * tier, so the sources are always one scroll away, even at the smallest sheet height.
 */
const PARTS: Record<PanelTier, { chips: boolean; cards: boolean; list: boolean; why: boolean }> = {
  peek: { chips: true, cards: false, list: false, why: false },
  half: { chips: false, cards: true, list: false, why: true },
  full: { chips: true, cards: false, list: true, why: true },
  all: { chips: false, cards: true, list: true, why: true },
  wide: { chips: false, cards: true, list: true, why: true },
};

interface Props {
  tier: PanelTier;
  state: PlanState;
  submission: Submission;
  selectedRouteId: string | null;
  selectedCheckpoint: CheckpointRef | null;
  onSelectRoute(routeId: string): void;
  onSelectCheckpoint(ref: CheckpointRef): void;
  onEditTrip(): void;
  /** The heading focus moves to when the results appear, so a screen reader starts there. */
  headingRef?: Ref<HTMLHeadingElement>;
}

/** What the sheet or pane shows. It is indifferent to which of the two holds it. */
export function PlanPanel({
  tier,
  state,
  submission,
  selectedRouteId,
  selectedCheckpoint,
  onSelectRoute,
  onSelectCheckpoint,
  onEditTrip,
  headingRef,
}: Props) {
  const parts = PARTS[tier];
  const routes = state.view?.routes ?? [];
  const recommendedId = state.view?.ranking?.recommended_id ?? null;
  const selected = routes.find((r) => r.id === selectedRouteId) ?? null;
  const detailCp =
    selected && selectedCheckpoint?.routeId === selected.id
      ? selected.checkpoints[selectedCheckpoint.index]
      : undefined;
  const criteria =
    state.explanation && 'criteria' in state.explanation ? state.explanation.criteria : undefined;

  // Said once when the answer lands. The wait and the errors speak for themselves, and the
  // recommendation is the headline's own text, so it is not said twice.
  const announcement =
    state.phase === 'ready'
      ? `Results ready. ${routes.length} ${routes.length === 1 ? 'route' : 'routes'} found.`
      : '';

  const list = parts.list && selected && (
    <CheckpointList
      route={selected}
      trip={submission.trip}
      selected={selectedCheckpoint}
      onSelect={onSelectCheckpoint}
    />
  );

  const routesColumn = (
    <Stack spacing={2}>
      <PlanHeadline state={state} submission={submission} onEditTrip={onEditTrip} />
      {state.view?.shortfall && (
        <Typography variant="body2" color="text.secondary">
          {state.view.shortfall}
        </Typography>
      )}
      {criteria && parts.why && <WhyThisRoute criteria={criteria} routes={routes} />}
      {routes.length > 0 && parts.chips && (
        <RouteChips
          routes={routes}
          selectedId={selectedRouteId}
          recommendedId={recommendedId}
          onSelect={onSelectRoute}
        />
      )}
      {routes.length > 0 && parts.cards && (
        <RouteCards
          routes={routes}
          trip={submission.trip}
          selectedId={selectedRouteId}
          recommendedId={recommendedId}
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
          />
        </Box>
      )}
      {tier !== 'wide' && list && (
        <>
          <Divider />
          {list}
        </>
      )}
      <Box>
        <Credits weather={state.weather?.attribution} address={submission.trip.addressCredit} />
      </Box>
    </Stack>
  );

  // Out of the stack, so its spacing does not count these two unseen elements as content.
  const unseen = (
    <>
      <Typography ref={headingRef} variant="h6" component="h2" tabIndex={-1} sx={visuallyHidden}>
        Routes from {placeName(submission.trip.origin.label)} to{' '}
        {placeName(submission.trip.destination.label)}
      </Typography>
      <Box role="status" sx={visuallyHidden}>
        {announcement}
      </Box>
    </>
  );

  return (
    <>
      {unseen}
      {tier === 'wide' ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr)',
            columnGap: 3,
          }}
        >
          {routesColumn}
          <Box>{list}</Box>
        </Box>
      ) : (
        routesColumn
      )}
    </>
  );
}
