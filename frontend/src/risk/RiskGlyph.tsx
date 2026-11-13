import { RISK_STYLE, type RiskKey } from './levels';

/** A level's shape in its colour. Decorative: the label next to it carries the meaning. */
export function RiskGlyph({ risk, size = 18 }: { risk: RiskKey; size?: number }) {
  const style = RISK_STYLE[risk];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={style.path}
        fill={style.outline ? 'none' : style.color}
        stroke={style.outline ? style.color : '#1b1b1b'}
        strokeWidth={style.outline ? 2.5 : 1.5}
        strokeDasharray={risk === 'pending' ? '3 3' : undefined}
        strokeLinejoin="round"
      />
    </svg>
  );
}
