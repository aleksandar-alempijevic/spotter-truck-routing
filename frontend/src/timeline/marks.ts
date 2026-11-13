import { formatClock, toLocalInput } from '../time/zone';
import { hourInstant, type GridModel } from './grid';

export interface SliderMark {
  value: number;
  label?: string;
}

const MIN_LABEL_GAP_HOURS = 5;

/**
 * Marks for the slider: now, the departure, and each local midnight. Labels that would sit on
 * top of one another are dropped, most important first; the tick stays.
 */
export function sliderMarks(model: GridModel, zone: string, nowMs: number): SliderMark[] {
  const last = model.hourCount - 1;
  const clamp = (hour: number) => Math.min(last, Math.max(0, Math.round(hour)));
  const departureMs = hourInstant(model, model.departureHour);
  const now = clamp((nowMs - model.startMs) / 3_600_000);
  const departure = clamp(model.departureHour);
  const together = Math.abs(departureMs - nowMs) < 30 * 60_000 || now === departure;

  const wanted: SliderMark[] = together
    ? [{ value: departure, label: 'Now' }]
    : [
        { value: now, label: 'Now' },
        { value: departure, label: 'Leave' },
      ];
  for (let hour = 1; hour <= last; hour++) {
    const ms = hourInstant(model, hour);
    if (toLocalInput(ms, zone).endsWith('T00:00')) {
      wanted.push({ value: hour, label: formatClock(ms, zone).split(' ')[0] });
    }
  }

  const marks: SliderMark[] = [];
  const labelled: number[] = [];
  for (const mark of wanted) {
    const existing = marks.find((m) => m.value === mark.value);
    if (existing) continue;
    const crowded = labelled.some((v) => Math.abs(v - mark.value) < MIN_LABEL_GAP_HOURS);
    if (crowded) marks.push({ value: mark.value });
    else {
      marks.push(mark);
      labelled.push(mark.value);
    }
  }
  return marks.sort((a, b) => a.value - b.value);
}
