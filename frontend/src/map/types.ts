import type { CheckpointRef } from '../plan/view';

/** How far each edge of the map is covered by the sheet, pane, trip bar or slider bar, in px. */
export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** What a tap on the map landed on: a heatmap cell, a checkpoint, or both. */
export interface MapSpot {
  /** The heatmap cell under the tap, when there is one. */
  cell: number | null;
  /** The checkpoint that was tapped, when one was. */
  checkpoint: CheckpointRef | null;
}
