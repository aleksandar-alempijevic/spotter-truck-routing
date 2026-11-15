import type { Condition, ConditionsOut } from '../api/types';
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
  /** A blow-over warning for a strong gust, or null. It never changes the level. */
  gustWarning: string | null;
}

const round = (n: number, places: number) => String(Math.round(n * 10 ** places) / 10 ** places);

const BLOW_OVER = 'risk of blow-over for light or empty trailers';

/** The warning line for one reading's gust; the server says whether the gust is strong enough. */
function gustLine(c: ConditionsOut | null): string | null {
  return c?.gust_warning ? `Gusts to ${round(c.gust_mph, 0)} mph — ${BLOW_OVER}` : null;
}

/** A route's gust warning in its two forms: the chip's short text and the full line. */
export function describeRouteGust(gustMph: number | null): { chip: string; line: string } | null {
  return gustMph === null
    ? null
    : {
        chip: `Gust ${gustMph} mph`,
        line: `Gusts to ${gustMph} mph on this route — ${BLOW_OVER}`,
      };
}

/**
 * What a checkpoint says about itself, in words. The list row and the hover popup both read from
 * here, so the two cannot disagree about a state.
 */
export function describeCheckpoint(
  cp: Pick<CheckpointView, 'risk' | 'conditions'>,
): CheckpointDescription {
  const { risk, conditions: c } = cp;
  const level = riskLabel(risk);
  if (risk.kind === 'pending') {
    return {
      level,
      readings: [],
      note: 'Weather not checked yet',
      decidedBy: null,
      decision: null,
      gustWarning: null,
    };
  }
  if (risk.kind === 'unavailable') {
    return {
      level,
      readings: [],
      note: 'Weather could not be loaded',
      decidedBy: null,
      decision: null,
      gustWarning: null,
    };
  }
  if (risk.kind === 'none' || !c) {
    return {
      level,
      readings: [],
      note: 'No forecast for this time',
      decidedBy: null,
      decision: null,
      gustWarning: null,
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
    gustWarning: gustLine(c),
  };
}

/** A heading and a few plain lines: what a readout says, wherever it is drawn. */
export interface Reading {
  title: string;
  lines: string[];
}

/**
 * A tapped checkpoint's two readings under one heading, each labelled with what it is: the
 * checkpoint's weather at its arrival time, and the heatmap cell's level at the slider's hour.
 * Without a checkpoint it is the heatmap's reading alone; without a heatmap, the checkpoint's.
 */
export function labelReadings(checkpoint: Reading | null, heat: Reading | null): Reading | null {
  if (!checkpoint) return heat;
  const [level, ...rest] = checkpoint.lines;
  return {
    title: checkpoint.title,
    lines: [
      `Checkpoint at arrival: ${level}`,
      ...rest,
      ...(heat ? [`Heatmap at slider hour: ${heat.title}`, ...heat.lines] : []),
    ],
  };
}
