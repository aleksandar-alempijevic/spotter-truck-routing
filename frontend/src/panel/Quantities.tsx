import { Fragment } from 'react';

/** A number with its unit: kept on one line, so a wrap never leaves "3 d 23 h 06" above "min". */
const QUANTITY = /(\d[\d,]*(?:\.\d+)? (?:d|h|min|mi|lb)\b)/g;

/** The text with each quantity kept whole; the spaces between quantities still wrap. */
export function Quantities({ text }: { text: string }) {
  return (
    <>
      {text.split(QUANTITY).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} style={{ whiteSpace: 'nowrap' }}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
