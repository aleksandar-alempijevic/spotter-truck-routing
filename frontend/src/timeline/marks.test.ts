import { expect, test } from 'vitest';
import { buildWeather } from '../test/fixtures';
import { buildGridModel } from './grid';
import { sliderMarks } from './marks';

// The grid starts at the top of the request's hour; the departure may be later.
const build = (departure: string, start = departure) => {
  const weather = buildWeather('mixed', { departure: start });
  return buildGridModel(weather.grid, departure);
};

test('leaving now is one mark, and each local midnight is marked with its day', () => {
  // 14:00 UTC is 08:00 in Chicago (CST), so local midnight is 06:00 UTC, at +16 h and +40 h.
  const model = build('2026-11-20T14:00:00Z');
  const marks = sliderMarks(model, 'America/Chicago', Date.parse('2026-11-20T14:05:00Z'));
  expect(marks[0]).toEqual({ value: 0, label: 'Now' });
  const days = marks.filter((m) => m.value > 0);
  expect(days.map((m) => m.value)).toEqual([16, 40]);
  expect(days.map((m) => m.label)).toEqual(['Sat', 'Sun']);
});

test('a later departure gets its own mark apart from now', () => {
  const model = build('2026-11-20T20:00:00Z', '2026-11-20T14:00:00Z');
  const marks = sliderMarks(model, 'America/Chicago', Date.parse('2026-11-20T14:00:00Z'));
  const labels = marks.filter((m) => m.label).map((m) => m.label);
  expect(labels).toContain('Now');
  expect(labels).toContain('Leave');
  expect(marks.find((m) => m.label === 'Leave')!.value).toBe(Math.round(model.departureHour));
});

test('a label that would sit on another is dropped and its tick kept', () => {
  // Departure at 06:00 UTC: Chicago midnight is +18 h... put "now" next to a midnight.
  const model = build('2026-11-20T04:30:00Z');
  const marks = sliderMarks(model, 'America/Chicago', Date.parse('2026-11-20T04:30:00Z'));
  const values = marks.map((m) => m.value);
  expect(new Set(values).size).toBe(values.length);
  const labelled = marks.filter((m) => m.label).map((m) => m.value);
  for (let i = 1; i < labelled.length; i++)
    expect(labelled[i] - labelled[i - 1]).toBeGreaterThanOrEqual(5);
  expect(marks.some((m) => !m.label)).toBe(true);
});

test('marks stay inside the hours the data has', () => {
  const model = build('2026-11-20T14:00:00Z');
  const marks = sliderMarks(model, 'America/Chicago', Date.parse('2026-11-01T00:00:00Z'));
  for (const m of marks) {
    expect(m.value).toBeGreaterThanOrEqual(0);
    expect(m.value).toBeLessThanOrEqual(model.hourCount - 1);
  }
});
