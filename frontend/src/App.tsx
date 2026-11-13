import { useEffect, useMemo, useState } from 'react';
import { INITIAL_VALUES, type FormValues } from './form/validation';
import { AppShell } from './layout/AppShell';
import { useLayoutMode } from './layout/useLayoutMode';
import { useSession } from './layout/useSession';
import { usePlan } from './plan/queries';
import { newSubmission, type Submission, type Trip } from './plan/trip';
import { buildGridModel, initialHour } from './timeline/grid';

/** The composition root: the form's values, the submitted trip, and what planning it returns. */
export function App() {
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const plan = usePlan(submission);
  const session = useSession(submission?.id ?? null, plan.view);
  const mode = useLayoutMode();

  const weather = plan.weather;
  const grid = useMemo(
    () => (weather ? buildGridModel(weather.grid, weather.departure) : null),
    [weather],
  );

  const { holder } = session;
  useEffect(() => {
    if (grid) holder.set(initialHour(grid));
  }, [grid, holder]);

  return (
    <AppShell
      mode={mode}
      values={values}
      onValues={setValues}
      submission={submission}
      onSubmit={(trip: Trip) => setSubmission(newSubmission(trip))}
      plan={plan}
      session={session}
      grid={grid}
    />
  );
}
