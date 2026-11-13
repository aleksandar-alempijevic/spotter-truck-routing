import { expect, test } from 'vitest';
import { cellFill, LEVELS_BY_SEVERITY, RISK_STYLE, worstRisk, type RiskState } from './levels';

const level = (l: (typeof LEVELS_BY_SEVERITY)[number]): RiskState => ({
  kind: 'level',
  level: l,
  condition: null,
  loadRaised: false,
});

test('every level has its own label, colour and shape', () => {
  const styles = Object.values(RISK_STYLE);
  expect(new Set(styles.map((s) => s.label)).size).toBe(styles.length);
  expect(new Set(styles.map((s) => s.color)).size).toBe(styles.length);
  // A dashed ring (pending) and a solid disc (Low) share an outline, so the fill counts too.
  expect(new Set(styles.map((s) => `${s.path}|${s.outline}`)).size).toBe(styles.length);
});

test('the worst of a set is its most severe level', () => {
  expect(worstRisk([level('low'), level('severe'), level('moderate')])).toEqual(level('severe'));
});

test('a level beats pending and no forecast, and neither is read as Low', () => {
  expect(worstRisk([{ kind: 'none' }, level('low'), { kind: 'pending' }])).toEqual(level('low'));
  expect(worstRisk([{ kind: 'none' }, { kind: 'pending' }])).toEqual({ kind: 'pending' });
  expect(worstRisk([{ kind: 'none' }])).toEqual({ kind: 'none' });
  expect(worstRisk([])).toEqual({ kind: 'none' });
});

function channels(fill: string): number[] {
  return fill.match(/[\d.]+/g)!.map(Number);
}

const luminance = ([r, g, b]: number[]) => {
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** What a cell can lie over: Positron's land, water and park, and the plain fallback. */
const GROUNDS = {
  land: [0xf2, 0xf3, 0xf0],
  water: [0xc2, 0xc8, 0xca],
  park: [0xdd, 0xea, 0xdd],
  plain: [0xe9, 0xee, 0xf2],
};
const LAND = GROUNDS.land;
/** The cell as it looks over a ground. */
const over = (level: (typeof LEVELS_BY_SEVERITY)[number], ground: number[]) => {
  const [r, g, b, alpha] = channels(cellFill(level));
  return [r, g, b].map((v, i) => Math.round(v * alpha + ground[i] * (1 - alpha)));
};

test('a cell is its level colour at its own opacity, quiet for Low', () => {
  expect(cellFill('low')).toBe('rgba(157,184,166,0.22)');
  expect(cellFill('severe')).toBe('rgba(100,10,18,0.9)');
});

test('Moderate to No Travel cells stand 3:1 off land, water, park and the plain background', () => {
  const [, ...strong] = LEVELS_BY_SEVERITY;
  for (const [name, ground] of Object.entries(GROUNDS)) {
    for (const level of strong) {
      expect(contrast(over(level, ground), ground), `${level} over ${name}`).toBeGreaterThanOrEqual(
        3,
      );
    }
  }
});

test('each level is darker than the last and neighbours differ in grey, not only in hue', () => {
  const [, ...strong] = LEVELS_BY_SEVERITY;
  const lums = LEVELS_BY_SEVERITY.map((level) => luminance(over(level, LAND)));
  for (let i = 1; i < lums.length; i++) expect(lums[i]).toBeLessThan(lums[i - 1]);
  for (let i = 1; i < strong.length; i++) {
    expect(contrast(over(strong[i], LAND), over(strong[i - 1], LAND))).toBeGreaterThanOrEqual(1.25);
  }
});
