import type { Condition } from '../api/types';
import { riskLabel } from '../risk/levels';
import type { CheckpointView } from './view';

export interface CheckpointDescription {
  /** The level's label, or what stands in for one ("Checking weather", "No forecast"). */
  level: string;
  /** The three readings in the driver's units, each rounded for reading; empty with no forecast. */
  readings: { condition: Condition; text: string }[];
  /** When there are no readings, why not. */
  note: string | null;
  /** The condition that set the level, to be marked among the readings. */
  decidedBy: Condition | null;
  /** Why the level is what it is: "Set by wind, raised a level by the load". */
  decision: string | null;
}

const round = (n: number, places: number) => String(Math.round(n * 10 ** places) / 10 ** places);

/**
 * What a checkpoint says about itself, in words. The list row and the hover popup both read from
 * here, so the two cannot disagree about a state.
 */
export function describeCheckpoint(cp: CheckpointView): CheckpointDescription {
  const { risk, conditions: c } = cp;
  const level = riskLabel(risk);
  if (risk.kind === 'pending') {
    return {
      level,
      readings: [],
      note: 'Weather not checked yet',
      decidedBy: null,
      decision: null,
    };
  }
  if (risk.kind === 'unavailable') {
    return {
      level,
      readings: [],
      note: 'Weather could not be loaded',
      decidedBy: null,
      decision: null,
    };
  }
  if (risk.kind === 'none' || !c) {
    return {
      level,
      readings: [],
      note: 'No forecast for this time',
      decidedBy: null,
      decision: null,
    };
  }
  const decidedBy = risk.kind === 'level' ? risk.condition : null;
  const by = decidedBy === null ? null : `Set by ${decidedBy}`;
  return {
    level,
    readings: [
      {
        condition: 'wind',
        text: `Wind ${round(c.wind_mph, 0)} mph (gusts ${round(c.gust_mph, 0)})`,
      },
      { condition: 'rain', text: `Rain ${round(c.rain_in_per_hr, 2)} in/h` },
      { condition: 'snow', text: `Snow ${round(c.snow_in_per_hr, 2)} in/h` },
    ],
    note: null,
    decidedBy,
    decision:
      by && (risk.kind === 'level' && risk.loadRaised ? `${by}, raised a level by the load` : by),
  };
}
