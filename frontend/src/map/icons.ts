import { CIRCLE_PATH, GLYPH_STROKE, HATCH, RISK_STYLE, type RiskKey } from '../risk/levels';

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

const STOP_SIZE = 34;

/**
 * The mark for a required stop and the weather it sits in: a dark octagon with a pause sign, a
 * shape and a colour that no risk glyph uses, with the level's own glyph on a white badge at its
 * corner. The level never rides on colour alone.
 */
export function stopImage(key: RiskKey): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = STOP_SIZE * RATIO;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(RATIO, RATIO);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i + Math.PI / 8;
    const x = 14 + Math.cos(angle) * 11;
    const y = 20 + Math.sin(angle) * 11;
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
  ctx.fillRect(10.2, 15, 2.8, 10);
  ctx.fillRect(15, 15, 2.8, 10);
  // The badge: a white disc with the level's glyph inside it.
  ctx.beginPath();
  ctx.arc(25, 9, 8.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#37474f';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const scale = 0.62;
  ctx.save();
  ctx.translate(25 - 12 * scale, 9 - 12 * scale);
  ctx.scale(scale, scale);
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
