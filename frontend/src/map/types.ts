/** How far each edge of the map is covered by the sheet, pane, trip bar or slider bar, in px. */
export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** What the hover popup on a checkpoint says: a heading and a few plain lines. */
export interface CheckpointPopup {
  title: string;
  lines: string[];
}
