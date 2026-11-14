import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TripForm } from '../form/TripForm';
import { TripSummary } from '../form/TripSummary';
import type { FormValues } from '../form/validation';
import type { CheckpointRef, RouteView, StopRef } from '../plan/view';
import { PlanPanel, type PanelTier } from '../panel/PlanPanel';
import { originClock } from '../panel/times';
import { describeCheckpoint } from '../plan/describe';
import type { PlanState } from '../plan/queries';
import { RISK_STYLE, type RiskKey } from '../risk/levels';
import { formatClockWithZone } from '../time/zone';
import { displayZone, type Submission, type Trip } from '../plan/trip';
import type { GridModel } from '../timeline/grid';
import { HourSlider } from '../timeline/HourSlider';
import { hourInstant } from '../timeline/grid';
import { Legend } from './Legend';
import type { MapSpot } from '../map/types';
import { MapCorner } from './MapCorner';
import { MapHost, type MapStatus } from './MapHost';
import { Sheet, type SheetState } from './Sheet';
import { SpotReading } from './SpotReading';
import { useBackCollapse } from './useBackCollapse';
import type { LayoutMode } from './useLayoutMode';
import type { Session } from './useSession';
import { useSize } from './useSize';
import { useViewportHeight } from './useViewportHeight';

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
const WIDE_PANE_WIDTH = 'clamp(740px, 38vw, 860px)';

const SAFE_TOP = 'env(safe-area-inset-top)';

// One empty list for every render before the routes arrive: a new `[]` each time would tell the
// map the routes had changed on every keystroke in the form.
const NO_ROUTES: readonly RouteView[] = [];

/** A map with less open height than this starts with its key closed. */
const KEY_OPEN_MIN_MAP_HEIGHT = 420;
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
  const [dragging, setDragging] = useState(false);
  // A tap on the map that the sheet reads out. It belongs to the plan and the grid it was read
  // from, and to the sheet layout: another plan, another grid or another layout leaves it behind.
  const [tapped, setTapped] = useState<{
    spot: MapSpot;
    grid: GridModel | null;
    submissionId: number | null;
  } | null>(null);
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');
  const cornerRef = useRef<HTMLDivElement>(null);
  // Where focus goes when the form closes: the results after a submit, "Edit trip" after "Back".
  const focusAfterForm = useRef<'results' | 'edit' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  // Open on a screen with room, closed over a phone's map, until the driver chooses.
  const [legendChoice, setLegendChoice] = useState<boolean | null>(null);
  const viewportHeight = useViewportHeight();
  const hasPlan = submission !== null;
  // No answer yet means no stops yet.
  const planHasStops = plan.view?.routes.some((r) => r.stops.length > 0) ?? false;
  const showForm = formOpen || !hasPlan;
  const isSheet = mode === 'sheet';
  if (tapped && !isSheet) setTapped(null);
  const spot =
    isSheet && tapped && tapped.grid === grid && tapped.submissionId === (submission?.id ?? null)
      ? tapped.spot
      : null;
  const paneWidth = mode === 'wide' ? WIDE_PANE_WIDTH : PANE_WIDTH;

  // Back closes an expanded sheet before it leaves the page.
  const collapseSheet = useCallback(() => setSheet('peek'), []);
  useBackCollapse(isSheet && hasPlan && !showForm && sheet !== 'peek', collapseSheet);

  const tripBarRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const tripBar = useSize(tripBarRef, isSheet && hasPlan && !showForm);
  const bottom = useSize(bottomRef, isSheet && hasPlan && !showForm, dragging);
  const pane = useSize(paneRef, !isSheet);
  const slider = useSize(sliderRef, !isSheet && hasPlan);

  // How much of each map edge the panels cover, so "fit the routes" lands in the open part.
  const insets = useMemo(
    () =>
      isSheet
        ? { top: tripBar.height, right: 0, bottom: bottom.height, left: 0 }
        : { top: 0, right: 0, bottom: slider.height, left: pane.width },
    [isSheet, tripBar.height, bottom.height, slider.height, pane.width],
  );

  // Focus follows the screen: the form opens on its first field (the form asks for it), and when
  // it closes focus goes to what the driver will read or press next.
  useEffect(() => {
    if (showForm) return;
    const target = focusAfterForm.current;
    focusAfterForm.current = null;
    (target === 'results' ? headingRef : target === 'edit' ? editRef : null)?.current?.focus();
  }, [showForm]);

  const submit = (trip: Trip) => {
    onSubmit(trip);
    focusAfterForm.current = 'results';
    setFormOpen(false);
    setSheet('peek');
  };

  const closeForm = () => {
    focusAfterForm.current = 'edit';
    setFormOpen(false);
  };

  const selectCheckpoint = (ref: CheckpointRef) => {
    session.selectCheckpoint(ref);
    // A mark chosen on the map asks the sheet for enough room to show it.
    setSheet((state) => (state === 'peek' ? 'half' : state));
  };

  // A stop chosen on the map is shown in the list, so the sheet opens far enough to show it.
  const selectStop = (ref: StopRef) => {
    session.selectStop(ref);
    setSheet((state) => (state === 'peek' ? 'half' : state));
  };

  // Where the map reports a tap: in the sheet the reading is shown there, and the sheet opens
  // far enough to show it.
  const onSpot = useCallback(
    (next: MapSpot | null) => {
      if (!isSheet) return;
      setTapped(next && { spot: next, grid, submissionId: submission?.id ?? null });
      if (next) setSheet((state) => (state === 'peek' ? 'half' : state));
    },
    [isSheet, grid, submission],
  );

  // The reading's own close ends the selection it came from as well: the ring and the list row.
  const closeSpot = () => {
    const ref = spot?.checkpoint;
    const now = session.checkpoint;
    if (ref && now && now.routeId === ref.routeId && now.index === ref.index) {
      session.clearCheckpoint();
    }
    setTapped(null);
  };

  const popupFor = useCallback(
    (ref: CheckpointRef) => {
      const route = plan.view?.routes.find((r) => r.id === ref.routeId);
      const cp = route?.checkpoints[ref.index];
      if (!route || !cp || !submission) return null;
      const { level, readings, note, decision } = describeCheckpoint(cp);
      const lines = [level, ...(note ? [note] : readings.map((r) => r.text))];
      if (decision) lines.push(decision);
      return {
        title: `${route.name} · mile ${Math.round(cp.mile)} · ${originClock(submission.trip, cp.etaMs)}`,
        lines,
      };
    },
    [plan.view, submission],
  );

  const cellFor = useCallback(
    (level: RiskKey, hour: number) => {
      if (!grid || !submission) return null;
      const when = formatClockWithZone(hourInstant(grid, hour), displayZone(submission.trip));
      return {
        title: level === 'none' ? 'No forecast here' : `${RISK_STYLE[level].label} here`,
        lines: [level === 'none' ? `No forecast for ${when}` : `Forecast for ${when}`],
      };
    },
    [grid, submission],
  );

  // What lies over the map's corner, so a readout can keep clear of it.
  const coveredRects = useCallback(
    () => (cornerRef.current ? [cornerRef.current.getBoundingClientRect()] : []),
    [],
  );

  const form = (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
        Truck Route Safety
      </Typography>
      <TripForm values={values} onChange={onValues} onSubmit={submit} autoFocus={hasPlan} />
      {hasPlan && (
        <Button sx={{ minHeight: 48 }} onClick={closeForm}>
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
        selectedStop={session.stop}
        onSelectRoute={session.selectRoute}
        onSelectCheckpoint={selectCheckpoint}
        onEditTrip={() => setFormOpen(true)}
        headingRef={headingRef}
      />
    );

  const sliderBar = (
    <Paper square elevation={isSheet ? 0 : 6} sx={{ borderTop: 1, borderColor: 'divider' }}>
      <HourSlider
        holder={session.holder}
        model={grid}
        zone={submission ? displayZone(submission.trip) : 'UTC'}
        routes={plan.view?.routes}
        nowMs={submission?.startedAt}
        weatherFailed={plan.view?.weather === 'failed'}
        routesFailed={plan.phase === 'routes_error'}
      />
    </Paper>
  );

  // The map is out of reach of the keyboard and of assistive technology while the phone's form
  // covers it, so Tab cannot reach the zoom buttons and credit links beneath.
  const mapBehindForm = isSheet && showForm;
  // The key starts open on a map with room for it, and closed on a short one.
  const mapHeight = viewportHeight - insets.top - insets.bottom;
  const keyOpen = legendChoice ?? (!isSheet && mapHeight >= KEY_OPEN_MIN_MAP_HEIGHT);

  return (
    <>
      <Box inert={mapBehindForm}>
        <MapHost
          routes={plan.view?.routes ?? NO_ROUTES}
          selectedRouteId={session.routeId}
          selectedCheckpoint={session.checkpoint}
          grid={grid}
          hour={session.holder}
          insets={insets}
          fitKey={submission?.id ?? 0}
          onSelectRoute={session.selectRoute}
          onSelectCheckpoint={selectCheckpoint}
          onSelectStop={selectStop}
          readoutOnMap={!isSheet}
          onSpot={onSpot}
          spotOpen={spot !== null}
          describeCheckpoint={popupFor}
          describeCell={cellFor}
          coveredRects={coveredRects}
          onStatus={setMapStatus}
        />

        <MapCorner
          ref={cornerRef}
          top={insets.top}
          right={insets.right}
          bottom={insets.bottom}
          left={insets.left}
          status={mapStatus}
        >
          {grid && hasPlan && !showForm && mapStatus !== 'failed' && (
            <Legend
              open={keyOpen}
              hasStops={planHasStops}
              onToggle={() => setLegendChoice(!keyOpen)}
            />
          )}
        </MapCorner>
      </Box>

      {isSheet ? (
        <>
          {submission && !showForm && (
            <>
              <Paper
                ref={tripBarRef}
                square
                elevation={4}
                sx={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 3, pt: SAFE_TOP }}
              >
                <TripSummary
                  ref={editRef}
                  trip={submission.trip}
                  breaksApplied={plan.view?.breaksApplied}
                  onClick={() => setFormOpen(true)}
                />
              </Paper>
              <Box
                ref={bottomRef}
                sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 3 }}
              >
                {sheet !== 'full' && sliderBar}
                <Sheet
                  state={sheet}
                  onState={setSheet}
                  topClearance={tripBar.height}
                  onDragging={setDragging}
                >
                  {(tier) => (
                    <>
                      {spot && (
                        <SpotReading
                          cell={spot.cell}
                          checkpoint={spot.checkpoint}
                          grid={grid}
                          holder={session.holder}
                          describeCheckpoint={popupFor}
                          describeCell={cellFor}
                          onClose={closeSpot}
                        />
                      )}
                      {panel(tier)}
                    </>
                  )}
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
              width: paneWidth,
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
                <TripSummary
                  ref={editRef}
                  trip={submission.trip}
                  breaksApplied={plan.view?.breaksApplied}
                  onClick={() => setFormOpen(true)}
                />
              </Box>
            )}
            <Box sx={{ p: 2 }}>{showForm ? form : panel(mode === 'wide' ? 'wide' : 'all')}</Box>
          </Paper>
          {hasPlan && (
            <Box
              ref={sliderRef}
              sx={{ position: 'fixed', bottom: 0, right: 0, zIndex: 3, left: paneWidth }}
            >
              {sliderBar}
            </Box>
          )}
        </>
      )}
    </>
  );
}
