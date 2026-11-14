import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { RISK_STYLE } from './levels';
import { StopMark } from './StopMark';
import { octagonPoints, STOP_MARK } from './stopGeometry';

afterEach(cleanup);

// The map draws the same mark on a canvas from `STOP_MARK`; these pin the key's SVG to it, so the
// two cannot drift apart.
test('the key draws the stop mark from the map geometry', () => {
  const { container } = render(<StopMark risk="low" size={30} />);

  const outer = container.querySelector('svg')!;
  expect(outer.getAttribute('viewBox')).toBe(`0 0 ${STOP_MARK.size} ${STOP_MARK.size}`);
  const polygon = container.querySelector('polygon')!;
  expect(polygon.getAttribute('points')).toBe(
    octagonPoints()
      .map(([x, y]) => `${x},${y}`)
      .join(' '),
  );
  expect(polygon.getAttribute('stroke-width')).toBe(String(STOP_MARK.octagon.rim));
  const bars = [...container.querySelectorAll('rect')].map((r) => ({
    x: Number(r.getAttribute('x')),
    y: Number(r.getAttribute('y')),
    width: Number(r.getAttribute('width')),
    height: Number(r.getAttribute('height')),
  }));
  expect(bars).toEqual(STOP_MARK.bars.map((bar) => ({ ...bar })));
  const badge = container.querySelector('circle')!;
  expect(Number(badge.getAttribute('cx'))).toBe(STOP_MARK.badge.cx);
  expect(Number(badge.getAttribute('cy'))).toBe(STOP_MARK.badge.cy);
  expect(Number(badge.getAttribute('r'))).toBe(STOP_MARK.badge.r);
  expect(badge.getAttribute('stroke-width')).toBe(String(STOP_MARK.badge.rim));
  const glyph = outer.querySelector('svg')!;
  const side = STOP_MARK.glyphBox * STOP_MARK.glyphScale;
  expect(Number(glyph.getAttribute('width'))).toBeCloseTo(side);
  expect(Number(glyph.getAttribute('x'))).toBeCloseTo(STOP_MARK.badge.cx - side / 2);
  expect(Number(glyph.getAttribute('y'))).toBeCloseTo(STOP_MARK.badge.cy - side / 2);
});

test('a solid level is filled in its colour, and an outline level sits on a white disc', () => {
  const solid = render(<StopMark risk="low" size={30} />).container;
  const solidPaths = solid.querySelectorAll('svg svg path');
  expect(solidPaths).toHaveLength(1);
  expect(solidPaths[0].getAttribute('fill')).toBe(RISK_STYLE.low.color);
  cleanup();

  const outline = render(<StopMark risk="none" size={30} />).container;
  const outlinePaths = outline.querySelectorAll('svg svg path');
  expect(outlinePaths).toHaveLength(2); // the disc, then the stroked shape
  expect(outlinePaths[0].getAttribute('fill')).toBe(STOP_MARK.paper);
  expect(outlinePaths[1].getAttribute('fill')).toBe('none');
});
