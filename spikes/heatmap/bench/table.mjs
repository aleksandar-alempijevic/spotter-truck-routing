// Prints a markdown table from bench/results-*.json files given as arguments.
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) {
  const { mode, throttle, renderer, results } = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`\n### ${mode}${throttle > 1 ? `, CPU ${throttle}x slower` : ''} — ${renderer}\n`);
  console.log('| Approach | Cells | Switch call (p50) | First frame p50 | Change visible p50 / p95 / max | Drag: input→paint p50 / p95 | Drag: frame gap p50 / p95 / max | Long tasks (count, total ms) | Requests during drag |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const t = r.tick, d = r.drag;
    console.log(`| ${r.approach} | ${r.cells} | ${t.sync.p50} | ${t.firstFrame.p50} | ${t.visible.p50} / ${t.visible.p95} / ${t.visible.max} | ${d.inputToPaint.p50} / ${d.inputToPaint.p95} | ${d.frameGap.p50} / ${d.frameGap.p95} / ${d.frameGap.max} | ${d.longTasks}, ${d.longTaskTotal} | ${d.networkRequests} |${r.errors.length ? ' errors: ' + r.errors.join('; ') : ''}`);
  }
}
