import { CIRCLE_PATH, GLYPH_STROKE, RISK_STYLE, type RiskKey } from '../risk/levels';

const SIZE = 24;
const RATIO = 2;

/** The glyph for a level or non-level as pixels, drawn from the same path the lists use. */
export function glyphImage(key: RiskKey): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE * RATIO;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(RATIO, RATIO);
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
  } else {
    ctx.fillStyle = style.color;
    ctx.fill(path);
    ctx.strokeStyle = GLYPH_STROKE.solidColor;
    ctx.lineWidth = GLYPH_STROKE.solidWidth;
    ctx.stroke(path);
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** A diagonal hatch tile for cells with no forecast. */
export function hatchImage(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#37474f';
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
