import { Box } from '@mui/material';
import { visuallyHidden } from '../visuallyHidden';

/**
 * A blow-over warning: a wind glyph and the words, in an accent colour no risk level uses, so a
 * glance finds it without it reading as a level. The glyph is decorative; the hidden prefix names
 * the line a warning for assistive technology.
 */
export function GustWarning({
  text,
  size = 'normal',
}: {
  text: string;
  size?: 'normal' | 'small';
}) {
  const px = size === 'small' ? 14 : 16;
  return (
    <Box
      component="span"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 0.5,
        color: 'info.dark',
        fontWeight: 700,
        fontSize: size === 'small' ? '0.75rem' : '0.8125rem',
        lineHeight: 1.35,
      }}
    >
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        style={{ flex: 'none', marginTop: 1 }}
      >
        <path
          d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8a2.5 2.5 0 1 1-2.5 2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        <Box component="span" sx={visuallyHidden}>
          Warning:{' '}
        </Box>
        {text}
      </span>
    </Box>
  );
}
