/**
 * The required-stop mark, in the 44-unit box the map draws it in: a dark octagon with a pause
 * sign, and the level's glyph on a white badge at the corner. The map's canvas and the key's SVG
 * both draw from these numbers, so the key shows what the map shows.
 */
export const STOP_MARK = {
  size: 44,
  ink: '#37474f',
  paper: '#ffffff',
  octagon: { cx: 17, cy: 27, r: 14, rim: 2 },
  bars: [
    { x: 12.2, y: 20.6, width: 3.6, height: 12.7 },
    { x: 18.3, y: 20.6, width: 3.6, height: 12.7 },
  ],
  badge: { cx: 32, cy: 12, r: 12, rim: 1.2 },
  /** A level glyph is drawn in this many units, at this scale: with the layer's 0.85, about 16 CSS px. */
  glyphBox: 24,
  glyphScale: 0.8,
} as const;

/** The octagon's eight corners, flat side up. */
export function octagonPoints(): [number, number][] {
  const { cx, cy, r } = STOP_MARK.octagon;
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (Math.PI / 4) * i + Math.PI / 8;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });
}
