import { CIRCLE_PATH, GLYPH_STROKE, RISK_STYLE, type RiskKey } from './levels';
import { octagonPoints, STOP_MARK } from './stopGeometry';

/** The map's stop mark as SVG, for the key. Decorative: the row's words carry the meaning. */
export function StopMark({ risk, size }: { risk: RiskKey; size: number }) {
  const { octagon, bars, badge, ink, paper, glyphBox, glyphScale } = STOP_MARK;
  const style = RISK_STYLE[risk];
  const glyph = glyphBox * glyphScale;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${STOP_MARK.size} ${STOP_MARK.size}`}
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        points={octagonPoints()
          .map(([x, y]) => `${x},${y}`)
          .join(' ')}
        fill={ink}
        stroke={paper}
        strokeWidth={octagon.rim}
        strokeLinejoin="round"
      />
      {bars.map((bar) => (
        <rect key={bar.x} {...bar} fill={paper} />
      ))}
      <circle
        cx={badge.cx}
        cy={badge.cy}
        r={badge.r}
        fill={paper}
        stroke={ink}
        strokeWidth={badge.rim}
      />
      <svg
        x={badge.cx - glyph / 2}
        y={badge.cy - glyph / 2}
        width={glyph}
        height={glyph}
        viewBox={`0 0 ${glyphBox} ${glyphBox}`}
      >
        {/* As the map paints it: an outline level sits on a white disc, with the path stroked. */}
        {style.outline && <path d={CIRCLE_PATH} fill={paper} />}
        <path
          d={style.path}
          fill={style.outline ? 'none' : style.color}
          stroke={style.outline ? style.color : GLYPH_STROKE.solidColor}
          strokeWidth={style.outline ? GLYPH_STROKE.outlineWidth : GLYPH_STROKE.solidWidth}
          strokeDasharray={style.dashed ? GLYPH_STROKE.pendingDash.join(' ') : undefined}
          strokeLinejoin="round"
        />
      </svg>
    </svg>
  );
}
