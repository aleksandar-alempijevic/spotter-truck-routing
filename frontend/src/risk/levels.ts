import type { Condition, Level } from '../api/types';

/**
 * How a checkpoint's risk reads. `pending` (the weather has not landed) and `none` (the server
 * has no forecast for that time) are different states and are never shown as Low.
 */
export type RiskState =
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'level'; level: Level; condition: Condition | null; loadRaised: boolean };

/** What can be drawn: a level, or one of the two non-levels. */
export type RiskKey = Level | 'pending' | 'none';

export interface RiskStyle {
  label: string;
  /** Fill colour for marks and the heatmap. */
  color: string;
  /** Text colour that reads on `color`. */
  onColor: string;
  /** SVG path in a 24 by 24 box. The same shape is drawn on the map and in the lists. */
  path: string;
  /** Drawn as an outline instead of a solid shape. */
  outline: boolean;
}

// One file owns the palette and the glyph set, so a review can change both in one place.
export const RISK_STYLE: Record<RiskKey, RiskStyle> = {
  low: {
    label: 'Low',
    color: '#9db8a6',
    onColor: '#102418',
    path: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z',
    outline: false,
  },
  moderate: {
    label: 'Moderate',
    color: '#f4d03f',
    onColor: '#2b2400',
    path: 'M5 5h14v14H5z',
    outline: false,
  },
  high: {
    label: 'High',
    color: '#f28c28',
    onColor: '#2b1500',
    path: 'M12 3L22 20H2z',
    outline: false,
  },
  severe: {
    label: 'Severe',
    color: '#d32f2f',
    onColor: '#ffffff',
    path: 'M12 1.5L22.5 12L12 22.5L1.5 12z',
    outline: false,
  },
  no_travel: {
    label: 'No Travel',
    color: '#7b1fa2',
    onColor: '#ffffff',
    path: 'M8 2h8l6 6v8l-6 6H8l-6-6V8z',
    outline: false,
  },
  pending: {
    label: 'Checking weather',
    color: '#78909c',
    onColor: '#102027',
    path: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z',
    outline: true,
  },
  none: {
    label: 'No forecast',
    color: '#546e7a',
    onColor: '#102027',
    path: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM6.3 6.3L17.7 17.7',
    outline: true,
  },
};

/** Least to most severe, for choosing the worst level of a set. The wire's `Level` order. */
export const LEVELS_BY_SEVERITY: readonly Level[] = [
  'low',
  'moderate',
  'high',
  'severe',
  'no_travel',
];

export function riskKey(state: RiskState): RiskKey {
  return state.kind === 'level' ? state.level : state.kind;
}

export function riskLabel(state: RiskState): string {
  return RISK_STYLE[riskKey(state)].label;
}

/** The most severe of a set of states; `none` and `pending` only when no level is present. */
export function worstRisk(states: readonly RiskState[]): RiskState {
  let worst: RiskState | null = null;
  for (const state of states) {
    if (state.kind !== 'level') continue;
    if (
      worst === null ||
      worst.kind !== 'level' ||
      LEVELS_BY_SEVERITY.indexOf(state.level) > LEVELS_BY_SEVERITY.indexOf(worst.level)
    ) {
      worst = state;
    }
  }
  if (worst) return worst;
  if (states.some((s) => s.kind === 'pending')) return { kind: 'pending' };
  return { kind: 'none' };
}
