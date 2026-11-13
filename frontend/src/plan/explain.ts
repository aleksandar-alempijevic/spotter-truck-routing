import { formatMiles } from './format';
import type { RankedRouteOut, RankingOut, RankingStep } from '../api/types';
import { formatDuration } from '../time/zone';
import type { RouteView } from './view';

interface RankedEntry {
  routeId: string;
  rank: number;
}

/** The ranking's steps in the order it applies them. */
const STEP_ORDER: readonly RankingStep[] = [
  'no_travel',
  'severe',
  'high',
  'average_risk',
  'travel_time',
  'miles',
  'route_id',
];

/** How a route fared against the winner at one step. */
export type Standing =
  | {
      /** Within tolerance of the best route still in the contest: a tie at this step. */
      kind: 'tie';
      /** The route's value minus the first route's, when the ranking supplies one for this step. */
      difference: number | null;
    }
  | {
      /** Left the contest for first place at this step. */
      kind: 'lost';
      /** The best route still in at this step. It is not always the winner. */
      againstId: string;
      routeValue: number | null;
      bestValue: number | null;
      tolerance: number;
    }
  | { kind: 'out' };

export interface CriteriaRow {
  step: RankingStep;
  /** This step is the one that decided first place. */
  decides: boolean;
  /** Routes other than the winner that were still in the contest after this step. */
  tiedWith: string[];
  /** Every route but the first, in rank order. This is no order between them. */
  standings: { routeId: string; standing: Standing }[];
}

/** The ranking's account of first place: one row per step, up to and including the deciding one. */
export interface Criteria {
  firstId: string;
  rows: CriteriaRow[];
  /** Routes whose comparison leaves out miles with no forecast, with how many. */
  noForecast: { routeId: string; miles: number }[];
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
      criteria: Criteria;
    }
  | {
      kind: 'one_route';
      routeId: string;
      timeCostSeconds: 0;
      fastestId: string;
      others: RankedEntry[];
    }
  | {
      kind: 'none_safe';
      firstRankedId: string;
      routeCount: number;
      others: RankedEntry[];
      /** Null when the only route is the one with No Travel miles. */
      criteria: Criteria | null;
    };

const DIFFERENCE_OF: Partial<
  Record<RankingStep, (c: NonNullable<RankedRouteOut['vs_first']>) => number | null>
> = {
  no_travel: (c) => c.no_travel_miles,
  severe: (c) => c.severe_miles,
  high: (c) => c.high_miles,
  average_risk: (c) => c.average_risk,
  travel_time: (c) => c.travel_time_seconds,
};

/**
 * First place only. A route that survived a step was within tolerance there, so the step is a tie
 * for it. A value is carried only where the ranking supplies it: the `vs_first` differences, and
 * the values at the step a route dropped.
 */
function buildCriteria(
  ranking: RankingOut,
  decidedBy: RankingStep | null,
  firstId: string,
): Criteria | null {
  if (decidedBy === null) return null;
  const ordered = [...ranking.routes].sort((a, b) => a.rank - b.rank);
  const others = ordered.filter((r) => r.id !== firstId);
  const rows: CriteriaRow[] = [];
  for (const step of STEP_ORDER.slice(0, STEP_ORDER.indexOf(decidedBy) + 1)) {
    const at = STEP_ORDER.indexOf(step);
    const standings = others.map(({ id, vs_first }): CriteriaRow['standings'][number] => {
      if (!vs_first) return { routeId: id, standing: { kind: 'out' } };
      const droppedAt = STEP_ORDER.indexOf(vs_first.dropped_at);
      if (droppedAt < at) return { routeId: id, standing: { kind: 'out' } };
      if (droppedAt === at) {
        const m = vs_first.dropped_against;
        return {
          routeId: id,
          standing: {
            kind: 'lost',
            againstId: m.best_route_id,
            routeValue: m.route_value,
            bestValue: m.best_value,
            tolerance: m.tolerance,
          },
        };
      }
      return {
        routeId: id,
        standing: { kind: 'tie', difference: DIFFERENCE_OF[step]?.(vs_first) ?? null },
      };
    });
    rows.push({
      step,
      decides: step === decidedBy,
      tiedWith: standings.filter((s) => s.standing.kind === 'tie').map((s) => s.routeId),
      standings,
    });
  }
  return {
    firstId,
    rows,
    noForecast: ordered
      .filter((r) => r.no_forecast_miles > 0)
      .map((r) => ({ routeId: r.id, miles: r.no_forecast_miles })),
  };
}

export function explain(ranking: RankingOut, routes: readonly RouteView[]): Explanation {
  const ordered = [...ranking.routes].sort((a, b) => a.rank - b.rank);
  const first = ordered[0];
  const others = ordered.slice(1).map((r) => ({ routeId: r.id, rank: r.rank }));

  if (ranking.recommended_id === null) {
    return {
      kind: 'none_safe',
      firstRankedId: first.id,
      routeCount: routes.length,
      others,
      criteria: buildCriteria(ranking, ranking.decided_by, first.id),
    };
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
    criteria: buildCriteria(ranking, ranking.decided_by, recommended.id)!,
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

export const STEP_NAME: Record<RankingStep, string> = {
  no_travel: 'No Travel miles',
  severe: 'Severe miles',
  high: 'High miles',
  average_risk: 'Average risk',
  travel_time: 'Travel time',
  miles: 'Total miles',
  route_id: 'Route order',
};

const miles = (n: number) => formatMiles(n, 1);

/** A step's value in the unit it is measured in. */
export function formatMeasure(step: RankingStep, value: number): string {
  if (step === 'travel_time') return formatDuration(value);
  if (step === 'average_risk') return value.toFixed(2);
  return miles(value);
}

/** A difference between two routes, signed, in the step's unit. */
export function formatDifference(step: RankingStep, value: number): string {
  if (Math.abs(value) < 1e-6) return 'same';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${formatMeasure(step, Math.abs(value))}`;
}

interface Described {
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
