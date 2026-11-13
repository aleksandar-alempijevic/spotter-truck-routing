import { expect, test } from 'vitest';
import { formatMiles } from './format';

test('miles get a thousands separator and the places asked for', () => {
  expect(formatMiles(1234.4)).toBe('1,234 mi');
  expect(formatMiles(12)).toBe('12 mi');
  expect(formatMiles(1234.56, 1)).toBe('1,234.6 mi');
  expect(formatMiles(12, 1)).toBe('12 mi');
});
