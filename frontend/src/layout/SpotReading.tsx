import { Box, ButtonBase, Paper, Typography } from '@mui/material';
import { labelReadings, type Reading } from '../plan/describe';
import type { RiskKey } from '../risk/levels';
import { levelKeyAt, type GridModel } from '../timeline/grid';
import { useHour, type HourHolder } from '../timeline/hourHolder';
import type { CheckpointRef } from '../plan/view';

interface Props {
  /** The heatmap cell that was tapped, if the tap was over one. */
  cell: number | null;
  /** The checkpoint that was tapped, if one was. */
  checkpoint: CheckpointRef | null;
  grid: GridModel | null;
  holder: HourHolder;
  /** What a checkpoint says about itself; null when it cannot be found. */
  describeCheckpoint(ref: CheckpointRef): Reading | null;
  /** What a heatmap cell's level at an hour says. */
  describeCell(level: RiskKey, hour: number): Reading | null;
  onClose(): void;
}

/**
 * What a tap on the map read, shown in the bottom sheet on a phone, where a popup over the map
 * would hide too much of it. The heatmap line follows the slider: the hour comes from the holder
 * by a subscription of this component's own, so a drag renders this and the slider, not the page.
 */
export function SpotReading({
  cell,
  checkpoint,
  grid,
  holder,
  describeCheckpoint,
  describeCell,
  onClose,
}: Props) {
  const hour = useHour(holder);
  const heat = grid && cell !== null ? describeCell(levelKeyAt(grid, cell, hour), hour) : null;
  const words = labelReadings(checkpoint ? describeCheckpoint(checkpoint) : null, heat);
  if (!words) return null;
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label="Weather at the tapped spot"
      sx={{
        // Stuck to the top of the sheet's scroll, so it is in view at every height and scroll.
        position: 'sticky',
        top: 0,
        zIndex: 1,
        bgcolor: 'background.paper',
        mb: 2,
        py: 1,
        pl: 1.5,
        pr: 6,
        minHeight: 44,
      }}
    >
      <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700 }}>
        {words.title}
      </Typography>
      {words.lines.map((line, i) => (
        <Typography key={i} variant="body2">
          {line}
        </Typography>
      ))}
      <ButtonBase
        aria-label="Close the weather reading"
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 44,
          height: 44,
          fontSize: 24,
          color: 'text.secondary',
        }}
      >
        <Box component="span" aria-hidden>
          ×
        </Box>
      </ButtonBase>
    </Paper>
  );
}
