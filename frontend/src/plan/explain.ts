import type { RankingOut, RankingStep } from '../api/types';
import { formatDuration } from '../time/zone';
import type { RouteView } from './view';

export interface RankedEntry {
  routeId: string;
  rank: number;
}

/** What the ranking says, without prose. Prose comes from `describe`. */
export type Explanation =
  | {
      kind: 'decided';
      routeId: string;
      step: RankingStep;
      timeCostSeconds: number;
      fastestId: string;
      /** Second and third place, best first, with no reason between them. */
      others: RankedEntry[];
    }
  | {
      kind: 'one_route';
      routeId: string;
      timeCostSeconds: 0;
      fastestId: string;
      others: RankedEntry[];
    }
  | { kind: 'none_safe'; firstRankedId: string; routeCount: number; others: RankedEntry[] };

export function explain(ranking: RankingOut, routes: readonly RouteView[]): Explanation {
  const ordered = [...ranking.routes].sort((a, b) => a.rank - b.rank);
  const first = ordered[0];
  const others = ordered.slice(1).map((r) => ({ routeId: r.id, rank: r.rank }));

  if (ranking.recommended_id === null) {
    return { kind: 'none_safe', firstRankedId: first.id, routeCount: routes.length, others };
  }
  const recommended = routes.find((r) => r.id === ranking.recommended_id)!;
  const fastest = routes.find((r) => r.isFastest)!;
  if (ranking.decided_by === null) {
    return {
      kind: 'one_route',
      routeId: recommended.id,
      timeCostSeconds: 0,
      fastestId: fastest.id,
      others,
    };
  }
  return {
    kind: 'decided',
    routeId: recommended.id,
    step: ranking.decided_by,
    timeCostSeconds: Math.max(0, recommended.travelSeconds - fastest.travelSeconds),
    fastestId: fastest.id,
    others,
  };
}

const STEP_REASON: Record<RankingStep, string> = {
  no_travel: 'Fewest No Travel miles.',
  severe: 'Fewest Severe miles.',
  high: 'Fewest High miles, within one checkpoint.',
  average_risk: 'Lowest average risk.',
  travel_time: 'Tied on risk, so the shortest travel time decides.',
  miles: 'Tied on risk and travel time, so the fewest miles decides.',
  route_id: 'No difference on any measure, so the first route listed is taken.',
};

export interface Described {
  headline: string;
  reason: string | null;
  cost: string | null;
}

/** The plain-words headline for an explanation. */
export function describe(explanation: Explanation, routes: readonly RouteView[]): Described {
  const name = (id: string) => routes.find((r) => r.id === id)?.name ?? id;

  if (explanation.kind === 'none_safe') {
    return {
      headline: 'No route is safe to recommend',
      reason:
        explanation.routeCount === 1
          ? 'The only route has No Travel miles.'
          : `Every route has No Travel miles. ${name(explanation.firstRankedId)} has the fewest.`,
      cost: null,
    };
  }
  const headline = `${name(explanation.routeId)} is recommended`;
  const cost =
    explanation.timeCostSeconds < 60
      ? explanation.routeId === explanation.fastestId
        ? 'It is also the fastest route.'
        : 'About as fast as the fastest route.'
      : `+${formatDuration(explanation.timeCostSeconds)} against the fastest route (${name(explanation.fastestId)}).`;
  if (explanation.kind === 'one_route') {
    return { headline, reason: 'It is the only route.', cost: null };
  }
  return { headline, reason: STEP_REASON[explanation.step], cost };
}
