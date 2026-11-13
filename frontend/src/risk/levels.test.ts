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
/** The cell as it looks over the Positron land colour. */
const overLand = (level: (typeof LEVELS_BY_SEVERITY)[number]) => {
  const [r, g, b, alpha] = channels(cellFill(level));
  return [r, g, b].map((v, i) => Math.round(v * alpha + LAND[i] * (1 - alpha)));
};
const LAND = [0xf2, 0xf3, 0xf0];

test('a cell is its level colour at its own opacity, quiet for Low', () => {
  expect(cellFill('low')).toBe('rgba(157,184,166,0.22)');
  expect(cellFill('severe')).toBe('rgba(134,0,5,0.85)');
});

test('Moderate to No Travel cells stand 3:1 off the land, and each is darker than the last', () => {
  const [, ...strong] = LEVELS_BY_SEVERITY;
  for (const level of strong) expect(contrast(overLand(level), LAND)).toBeGreaterThanOrEqual(3);
  const lums = LEVELS_BY_SEVERITY.map((level) => luminance(overLand(level)));
  for (let i = 1; i < lums.length; i++) expect(lums[i]).toBeLessThan(lums[i - 1]);
  // Neighbouring levels differ in grey too, not only in hue.
  for (let i = 1; i < strong.length; i++) {
    expect(contrast(overLand(strong[i]), overLand(strong[i - 1]))).toBeGreaterThanOrEqual(1.25);
  }
});
