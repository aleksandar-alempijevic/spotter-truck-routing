import { CIRCLE_PATH, GLYPH_STROKE, HATCH, RISK_STYLE, type RiskKey } from '../risk/levels';

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

/**
 * The mark for a required stop: a dark octagon with a pause sign, a shape and a colour that no
 * risk glyph uses.
 */
export function stopImage(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE * RATIO;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(RATIO, RATIO);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const centre = SIZE / 2;
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i + Math.PI / 8;
    const x = centre + Math.cos(angle) * 10.5;
    const y = centre + Math.sin(angle) * 10.5;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#37474f';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(8.5, 7.5, 2.6, 9);
  ctx.fillRect(12.9, 7.5, 2.6, 9);
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
