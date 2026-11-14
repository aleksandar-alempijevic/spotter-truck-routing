import { CIRCLE_PATH, GLYPH_STROKE, HATCH, RISK_STYLE, type RiskKey } from '../risk/levels';
import { octagonPoints, STOP_MARK } from '../risk/stopGeometry';

const SIZE = 24;
const RATIO = 2;

/** Draws a level's glyph in the 24-unit box at the context's current origin and scale. */
function drawGlyph(ctx: CanvasRenderingContext2D, key: RiskKey): void {
  const style = RISK_STYLE[key];
  const path = new Path2D(style.path);
  ctx.lineJoin = 'round';
  if (style.outline) {
    ctx.fillStyle = '#ffffff';
    ctx.fill(new Path2D(CIRCLE_PATH));
    ctx.strokeStyle = style.color;
    ctx.lineWidth = GLYPH_STROKE.outlineWidth;
    if (style.dashed) ctx.setLineDash([...GLYPH_STROKE.pendingDash]);
    ctx.stroke(path);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = style.color;
    ctx.fill(path);
    ctx.strokeStyle = GLYPH_STROKE.solidColor;
    ctx.lineWidth = GLYPH_STROKE.solidWidth;
    ctx.stroke(path);
  }
}

/** The glyph for a level or non-level as pixels, drawn from the same path the lists use. */
export function glyphImage(key: RiskKey): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE * RATIO;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(RATIO, RATIO);
  drawGlyph(ctx, key);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * The mark for a required stop and the weather it sits in: a dark octagon with a pause sign, a
 * shape and a colour that no risk glyph uses, with the level's own glyph on a white badge at its
 * corner. The level never rides on colour alone. Its geometry is `STOP_MARK`, which the key draws
 * too.
 */
export function stopImage(key: RiskKey): ImageData {
  const { size, ink, paper, octagon, bars, badge, glyphBox, glyphScale } = STOP_MARK;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * RATIO;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(RATIO, RATIO);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  octagonPoints().forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.strokeStyle = paper;
  ctx.lineWidth = octagon.rim;
  ctx.stroke();
  ctx.fillStyle = paper;
  for (const bar of bars) ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
  // The badge: a white disc with the level's glyph inside it.
  ctx.beginPath();
  ctx.arc(badge.cx, badge.cy, badge.r, 0, Math.PI * 2);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = badge.rim;
  ctx.stroke();
  ctx.save();
  ctx.translate(badge.cx - (glyphBox / 2) * glyphScale, badge.cy - (glyphBox / 2) * glyphScale);
  ctx.scale(glyphScale, glyphScale);
  drawGlyph(ctx, key);
  ctx.restore();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** A diagonal hatch tile for cells with no forecast. */
export function hatchImage(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = HATCH.ink;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-1, 9);
  ctx.lineTo(9, -1);
  ctx.moveTo(-1, 1);
  ctx.lineTo(1, -1);
  ctx.moveTo(7, 9);
  ctx.lineTo(9, 7);
  ctx.stroke();
  return ctx.getImageData(0, 0, 8, 8);
}

export const ICON_PIXEL_RATIO = RATIO;
