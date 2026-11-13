import { useCallback, useState } from 'react';
import type { CheckpointRef } from '../plan/view';
import type { PlanView } from '../plan/view';
import { createHourHolder, type HourHolder } from '../timeline/hourHolder';

export interface Session {
  /** The slider's hour. */
  holder: HourHolder;
  /** The route shown as selected: the driver's pick, else the recommended route, else the fastest. */
  routeId: string | null;
  checkpoint: CheckpointRef | null;
  selectRoute(routeId: string): void;
  selectCheckpoint(ref: CheckpointRef): void;
}

interface Held {
  submissionId: number | null;
  holder: HourHolder;
  routeId: string | null;
  checkpoint: CheckpointRef | null;
}

const fresh = (submissionId: number | null): Held => ({
  submissionId,
  holder: createHourHolder(),
  routeId: null,
  checkpoint: null,
});

function defaultRoute(view: PlanView | null): string | null {
  if (!view || view.routes.length === 0) return null;
  const recommended = view.ranking?.recommended_id;
  if (recommended) return recommended;
  const first = view.ranking?.routes.find((r) => r.rank === 1)?.id;
  return first ?? view.routes.find((r) => r.isFastest)?.id ?? view.routes[0].id;
}

/**
 * What belongs to one planning attempt and must not outlive it: the selected route and checkpoint
 * and the slider hour. All of it is replaced when the submission's identity changes, so a re-plan
 * cannot carry a selection across by route id.
 */
export function useSession(submissionId: number | null, view: PlanView | null): Session {
  const [held, setHeld] = useState(() => fresh(submissionId));
  let current = held;
  if (held.submissionId !== submissionId) {
    current = fresh(submissionId);
    setHeld(current);
  }

  const selectRoute = useCallback(
    (routeId: string) =>
      setHeld((old) => (old.routeId === routeId ? old : { ...old, routeId, checkpoint: null })),
    [],
  );
  const selectCheckpoint = useCallback(
    (ref: CheckpointRef) => setHeld((old) => ({ ...old, routeId: ref.routeId, checkpoint: ref })),
    [],
  );

  return {
    holder: current.holder,
    routeId: current.routeId ?? defaultRoute(view),
    checkpoint: current.checkpoint,
    selectRoute,
    selectCheckpoint,
  };
}
