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

test('a cell is its level colour at the map opacity, quiet for Low', () => {
  expect(cellFill('low')).toBe('rgba(157,184,166,0.22)');
  expect(cellFill('severe')).toBe('rgba(211,47,47,0.62)');
});
