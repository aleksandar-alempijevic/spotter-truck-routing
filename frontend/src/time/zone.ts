// Wall-clock time in a named zone, using the platform's Intl only.

export const HOUR_MS = 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', ...options });
    formatters.set(key, found);
  }
  return found;
}

function parts(ms: number, zone: string, options: Intl.DateTimeFormatOptions) {
  const out: Record<string, string> = {};
  for (const part of formatter(zone, options).formatToParts(ms)) out[part.type] = part.value;
  return out;
}

const NUMERIC = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
} as const;

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function offsetAt(ms: number, zone: string): number {
  const p = parts(ms, zone, NUMERIC);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The instant a `YYYY-MM-DDTHH:mm` wall-clock time names in a zone. An ambiguous time (clocks go
 * back) is the earlier of the two; a time that does not exist (clocks go forward) is read with
 * the offset from before the change, so it lands an hour later on the clock.
 */
export function wallClockToInstant(local: string, zone: string): number | null {
  const match = LOCAL_INPUT.exec(local);
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const first = offsetAt(asUtc, zone);
  const guess = asUtc - first;
  const second = offsetAt(guess, zone);
  if (second === first) return guess;
  const retry = asUtc - second;
  return offsetAt(retry, zone) === second ? retry : guess;
}

/** `YYYY-MM-DDTHH:mm` for an instant as read on a clock in the zone (a `datetime-local` value). */
export function toLocalInput(ms: number, zone: string): string {
  const p = parts(ms, zone, NUMERIC);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** "Tue 14:00". */
export function formatClock(ms: number, zone: string): string {
  const p = parts(ms, zone, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** "Tue": the weekday's short name on a clock in the zone. */
export function formatWeekday(ms: number, zone: string): string {
  return parts(ms, zone, { weekday: 'short' }).weekday;
}

/** Whether the clock in the zone reads midnight at this instant. */
export function isLocalMidnight(ms: number, zone: string): boolean {
  const p = parts(ms, zone, { hour: '2-digit', minute: '2-digit' });
  return p.hour === '00' && p.minute === '00';
}

/** "Tue 14:00 CST": the clock plus the zone's short name at that instant. */
export function formatClockWithZone(ms: number, zone: string): string {
  return `${formatClock(ms, zone)} ${zoneAbbreviation(ms, zone)}`;
}

/** The zone's short name at an instant, such as "CST" or "GMT-6". */
export function zoneAbbreviation(ms: number, zone: string): string {
  return parts(ms, zone, { timeZoneName: 'short' }).timeZoneName ?? zone;
}

/** The zone's long name at an instant, such as "Central Standard Time". */
export function zoneName(ms: number, zone: string): string {
  return parts(ms, zone, { timeZoneName: 'long' }).timeZoneName ?? zone;
}

/**
 * "35 min", "4 h 05 min", "1 d 3 h", "1 d 1 h 04 min": days, hours and minutes, each part that is
 * not zero, so a day or more keeps its minutes like a shorter time does. Minutes after hours are
 * two digits, and a zero hour between days and minutes is spelled out ("1 d 0 h 05 min").
 */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(Math.abs(seconds) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0 || (days > 0 && minutes > 0)) parts.push(`${hours} h`);
  if (minutes > 0 || parts.length === 0) {
    parts.push(parts.length > 0 ? `${String(minutes).padStart(2, '0')} min` : `${minutes} min`);
  }
  return parts.join(' ');
}
