import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { useMemo, useRef, useState } from 'react';
import { TripForm } from '../form/TripForm';
import { TripSummary } from '../form/TripSummary';
import type { FormValues } from '../form/validation';
import type { CheckpointRef } from '../map/types';
import { PlanPanel, type PanelTier } from '../panel/PlanPanel';
import type { PlanState } from '../plan/queries';
import { displayZone, type Submission, type Trip } from '../plan/trip';
import type { GridModel } from '../timeline/grid';
import { HourSlider } from '../timeline/HourSlider';
import { MapHost } from './MapHost';
import { Sheet, type SheetState } from './Sheet';
import type { LayoutMode } from './useLayoutMode';
import type { Session } from './useSession';
import { useSize } from './useSize';

interface Props {
  mode: LayoutMode;
  values: FormValues;
  onValues(values: FormValues): void;
  submission: Submission | null;
  onSubmit(trip: Trip): void;
  plan: PlanState;
  session: Session;
  grid: GridModel | null;
}

const PANE_WIDTH = {
  xs: 340,
  sm: 350,
  md: 'clamp(340px, 30vw, 400px)',
  lg: 'clamp(380px, 28vw, 440px)',
} as const;

const SAFE_TOP = 'env(safe-area-inset-top)';

/** The page: the map behind, and either a bottom sheet or a side pane over it. */
export function AppShell({
  mode,
  values,
  onValues,
  submission,
  onSubmit,
  plan,
  session,
  grid,
}: Props) {
  const [formOpen, setFormOpen] = useState(true);
  const [sheet, setSheet] = useState<SheetState>('peek');
  const hasPlan = submission !== null;
  const showForm = formOpen || !hasPlan;

  const tripBarRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const tripBar = useSize(tripBarRef, mode === 'sheet' && hasPlan && !showForm);
  const bottom = useSize(bottomRef, mode === 'sheet' && hasPlan && !showForm);
  const pane = useSize(paneRef, mode === 'pane');
  const slider = useSize(sliderRef, mode === 'pane' && hasPlan);

  // How much of each map edge the panels cover, so "fit the routes" lands in the open part.
  const insets = useMemo(
    () =>
      mode === 'sheet'
        ? { top: tripBar.height, right: 0, bottom: bottom.height, left: 0 }
        : { top: 0, right: 0, bottom: slider.height, left: pane.width },
    [mode, tripBar.height, bottom.height, slider.height, pane.width],
  );

  const submit = (trip: Trip) => {
    onSubmit(trip);
    setFormOpen(false);
    setSheet('peek');
  };

  const selectCheckpoint = (ref: CheckpointRef) => {
    session.selectCheckpoint(ref);
    // A mark chosen on the map asks the sheet for enough room to show it.
    setSheet((state) => (state === 'peek' ? 'half' : state));
  };

  const form = (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
        Truck Route Safety
      </Typography>
      <TripForm values={values} onChange={onValues} onSubmit={submit} />
      {hasPlan && (
        <Button sx={{ minHeight: 48 }} onClick={() => setFormOpen(false)}>
          Back to results
        </Button>
      )}
    </Stack>
  );

  const panel = (tier: PanelTier) =>
    submission && (
      <PlanPanel
        tier={tier}
        state={plan}
        submission={submission}
        selectedRouteId={session.routeId}
        selectedCheckpoint={session.checkpoint}
        onSelectRoute={session.selectRoute}
        onSelectCheckpoint={selectCheckpoint}
        onEditTrip={() => setFormOpen(true)}
      />
    );

  const sliderBar = (
    <Paper
      square
      elevation={mode === 'sheet' ? 0 : 6}
      sx={{ borderTop: 1, borderColor: 'divider' }}
    >
      <HourSlider
        holder={session.holder}
        model={grid}
        zone={submission ? displayZone(submission.trip) : 'UTC'}
      />
    </Paper>
  );

  return (
    <>
      <MapHost
        routes={plan.view?.routes ?? []}
        selectedRouteId={session.routeId}
        selectedCheckpoint={session.checkpoint}
        grid={grid}
        hour={session.holder}
        insets={insets}
        fitKey={submission?.id ?? 0}
        onSelectRoute={session.selectRoute}
        onSelectCheckpoint={selectCheckpoint}
      />

      {mode === 'sheet' ? (
        <>
          {submission && !showForm && (
            <>
              <Paper
                ref={tripBarRef}
                square
                elevation={4}
                sx={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 3, pt: SAFE_TOP }}
              >
                <TripSummary trip={submission.trip} onClick={() => setFormOpen(true)} />
              </Paper>
              <Box
                ref={bottomRef}
                sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 3 }}
              >
                {sheet !== 'full' && sliderBar}
                <Sheet state={sheet} onState={setSheet} topClearance={tripBar.height}>
                  {panel(sheet)}
                </Sheet>
              </Box>
            </>
          )}
          {showForm && (
            <Box
              sx={{
                position: 'fixed',
                inset: 0,
                zIndex: 4,
                bgcolor: 'background.paper',
                overflowY: 'auto',
                px: 2,
                pt: `calc(16px + ${SAFE_TOP})`,
                pb: 'env(safe-area-inset-bottom)',
              }}
            >
              {form}
            </Box>
          )}
        </>
      ) : (
        <>
          <Paper
            ref={paneRef}
            square
            elevation={6}
            component="section"
            aria-label="Trip, routes and weather"
            sx={{
              position: 'fixed',
              top: 0,
              bottom: 0,
              left: 0,
              width: PANE_WIDTH,
              zIndex: 3,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }}
          >
            {submission && !showForm && (
              <Box
                sx={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  bgcolor: 'background.paper',
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <TripSummary trip={submission.trip} onClick={() => setFormOpen(true)} />
              </Box>
            )}
            <Box sx={{ p: 2 }}>{showForm ? form : panel('all')}</Box>
          </Paper>
          {hasPlan && (
            <Box
              ref={sliderRef}
              sx={{ position: 'fixed', bottom: 0, right: 0, zIndex: 3, left: PANE_WIDTH }}
            >
              {sliderBar}
            </Box>
          )}
        </>
      )}
    </>
  );
}
