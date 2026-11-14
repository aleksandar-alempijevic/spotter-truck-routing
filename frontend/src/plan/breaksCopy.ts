/**
 * What the rest-break switch says about itself, in one place: the form's help, the plan's note
 * and the list's caption all end on the same assumptions.
 */

/** The rule the switch applies, as the driver reads it. */
export const BREAKS_RULE =
  'a 30-minute break after 8 hours of driving, 10 hours off after 11, and 34 hours off after 60 hours of driving';

/** Said wherever a time or a stop includes the breaks. */
export const STOPS_ASSUMPTION =
  'The stops assume a rested start and no time except driving; each is placed where its limit is reached, which may not be a truck stop.';

/** Said beside the switch, not behind a link. */
export const BREAKS_HELP = `Adds ${BREAKS_RULE}. ${STOPS_ASSUMPTION}`;

/** Said once above the routes when the plan includes breaks: short, with the rest behind a disclosure. */
export const BREAKS_NOTE = 'Times include the federal rest breaks.';
export const BREAKS_NOTE_DETAIL = `The rule applied: ${BREAKS_RULE}. ${STOPS_ASSUMPTION}`;
