import { GLYPH_STROKE, RISK_STYLE, type RiskKey } from './levels';

/** A level's shape in its colour. Decorative: the label next to it carries the meaning. */
export function RiskGlyph({ risk, size = 18 }: { risk: RiskKey; size?: number }) {
  const style = RISK_STYLE[risk];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={style.path}
        fill={style.outline ? 'none' : style.color}
        stroke={style.outline ? style.color : GLYPH_STROKE.solidColor}
        strokeWidth={style.outline ? GLYPH_STROKE.outlineWidth : GLYPH_STROKE.solidWidth}
        strokeDasharray={style.dashed ? GLYPH_STROKE.pendingDash.join(' ') : undefined}
        strokeLinejoin="round"
      />
    </svg>
  );
}
