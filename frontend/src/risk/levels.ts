import type { Condition, Level } from '../api/types';

/**
 * How a checkpoint's risk reads. `pending` (the weather has not landed) and `none` (the server
 * has no forecast for that time) are different states and are never shown as Low.
 */
export type RiskState =
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'none' }
  | { kind: 'level'; level: Level; condition: Condition | null; loadRaised: boolean };

/** What can be drawn: a level, or one of the three non-levels. */
export type RiskKey = Level | 'pending' | 'unavailable' | 'none';

/**
 * The heatmap's own ramp, in its own table because a cell is a large area over the basemap: it
 * has to stand out from what it covers, where a small glyph does not: Positron's land (`#f2f3f0`),
 * water (`#c2c8ca`) and park (`#ddeadd`) and the plain fallback background (`#e9eef2`). Moderate
 * through No Travel measure at least 3:1 against each of them, and each step is darker than
 * the one before, so the levels also separate in greyscale. Low is a deliberately quiet tint, the
 * one level exempt from the 3:1 rule, so the map stays calm where nothing matters.
 * `risk/levels.test.ts` measures the ramp.
 */
const CELL: Record<Level, { rgb: string; alpha: number }> = {
  low: { rgb: '#9db8a6', alpha: 0.22 },
  moderate: { rgb: '#7a5c00', alpha: 0.9 },
  high: { rgb: '#8a3200', alpha: 0.9 },
  severe: { rgb: '#640a12', alpha: 0.9 },
  no_travel: { rgb: '#260040', alpha: 0.9 },
};

/** A heatmap cell's fill for a level, as `rgba(...)`. The map and the key both read it. */
export function cellFill(level: Level): string {
  const { rgb, alpha } = CELL[level];
  const n = parseInt(rgb.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** The hatch for "no forecast": drawn on the map as lines, and as a swatch in the key and cards. */
export const HATCH = { ink: '#37474f', paper: '#eceff1' } as const;
export const HATCH_CSS = `repeating-linear-gradient(45deg, ${HATCH.ink} 0 2px, ${HATCH.paper} 2px 5px)`;

/** A 16-unit circle in the 24-unit glyph box: the Low mark and the base of the outline marks. */
export const CIRCLE_PATH = 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z';

/** How both renderers (the SVG in lists, the canvas on the map) stroke a glyph. */
export const GLYPH_STROKE = {
  solidColor: '#1b1b1b',
  solidWidth: 1.6,
  outlineWidth: 2.5,
  pendingDash: [3, 3],
} as const;

interface RiskStyle {
  label: string;
  /** Fill colour of the level's marks and of its bars in the route cards. */
  color: string;
  /** SVG path in a 24 by 24 box. The same shape is drawn on the map and in the lists. */
  path: string;
  /** Drawn as an outline instead of a solid shape. */
  outline: boolean;
  /** The outline is dashed: something that has not arrived. */
  dashed?: boolean;
}

// One file owns the palette and the glyph set, so a review can change both in one place.
export const RISK_STYLE: Record<RiskKey, RiskStyle> = {
  low: {
    label: 'Low',
    color: '#9db8a6',
    path: CIRCLE_PATH,
    outline: false,
  },
  moderate: {
    label: 'Moderate',
    color: '#f4d03f',
    path: 'M5 5h14v14H5z',
    outline: false,
  },
  high: {
    label: 'High',
    color: '#f28c28',
    path: 'M12 3L22 20H2z',
    outline: false,
  },
  severe: {
    label: 'Severe',
    color: '#d32f2f',
    path: 'M12 1.5L22.5 12L12 22.5L1.5 12z',
    outline: false,
  },
  no_travel: {
    label: 'No Travel',
    color: '#7b1fa2',
    path: 'M8 2h8l6 6v8l-6 6H8l-6-6V8z',
    outline: false,
  },
  pending: {
    label: 'Checking weather',
    color: '#78909c',
    path: CIRCLE_PATH,
    outline: true,
    dashed: true,
  },
  unavailable: {
    label: 'Weather unavailable',
    color: '#607d8b',
    path: `${CIRCLE_PATH}M7.5 12h9`,
    outline: true,
    dashed: true,
  },
  none: {
    label: 'No forecast',
    color: '#546e7a',
    path: `${CIRCLE_PATH}M6.3 6.3L17.7 17.7`,
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

/** The most severe of a set of states; `none`, `pending` and `unavailable` only when no level is present. */
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
  if (states.some((s) => s.kind === 'unavailable')) return { kind: 'unavailable' };
  if (states.some((s) => s.kind === 'pending')) return { kind: 'pending' };
  return { kind: 'none' };
}
