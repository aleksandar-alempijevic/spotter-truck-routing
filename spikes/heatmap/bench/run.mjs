// Benchmark runner: serves dist/ in-process, drives headless Chromium with Playwright,
// prints and writes per-approach numbers. Usage:
//   node bench/run.mjs [--mode=shell|gpu] [--approaches=a,b] [--cells=500,2000] [--out=results.json]
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const MODE = args.mode ?? 'shell';
const APPROACHES = (args.approaches ?? 'global,global-array,global-lean,paint,feature,feature-diff,layers,rebuild').split(',');
const CELLS = (args.cells ?? '500,2000').split(',').map(Number);
const THROTTLE = Number(args.throttle ?? 1); // CDP CPU slowdown factor, e.g. 4 for a mid-range laptop
const OUT = args.out ?? `bench/results-${MODE}${THROTTLE > 1 ? `-cpu${THROTTLE}x` : ''}.json`;

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
  try {
    const body = await readFile(join(root, path && path !== '.' ? path : 'index.html'));
    res.writeHead(200, { 'content-type': types[extname(path && path !== '.' ? path : 'index.html')] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// CHROME_PATH lets the run reuse an already-installed Chromium instead of downloading one.
const launch = MODE === 'gpu'
  ? { channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] }
  : {};
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch({ headless: true, ...launch });

const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const summary = (xs) => ({ p50: r1(q(xs, 0.5)), p95: r1(q(xs, 0.95)), max: r1(Math.max(...xs)) });

const results = [];
let renderer = '';
try {
  for (const cells of CELLS) for (const approach of APPROACHES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}?approach=${approach}&cells=${cells}${args.extra ? `&${args.extra}` : ''}`);
    if (THROTTLE > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    }
    await page.waitForFunction(() => window.__spikeReady === true, null, { timeout: 60000 });
    await page.evaluate(() => window.__spike.waitIdle());
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__spike.waitIdle());
    renderer ||= await page.evaluate(() => window.__spike.renderer());
    const actualCells = await page.evaluate(() => window.__spike.cells);

    // 1. Sequential ticks 1..48, each awaited to idle.
    for (const h of [1, 2, 0]) await page.evaluate((h) => window.__spike.measureTick(h), h); // warm-up
    const ticks = [];
    for (let h = 1; h < 49; h++) ticks.push(await page.evaluate((h) => window.__spike.measureTick(h), h));
    if (args.shots) {
      await page.evaluate(() => window.__spike.measureTick(24));
      await page.screenshot({ path: `bench/shots/${approach}-${cells}-h24.png` });
    }
    await page.evaluate(() => window.__spike.measureTick(0));

    // 2. Scripted drag of the real slider across all 49 hours at ~60 Hz pointer moves.
    const box = await page.locator('#hour').boundingBox();
    const y = box.y + box.height / 2;
    const xAt = (h) => box.x + 8 + (box.width - 16) * (h / 48);
    let requests = 0;
    const countReq = () => { requests++; };
    await page.mouse.move(xAt(0), y);
    await page.mouse.down();
    await page.evaluate(() => window.__spike.start());
    page.on('request', countReq);
    const t0 = Date.now();
    for (let h = 1; h < 49; h++) { await page.mouse.move(xAt(h), y); await page.waitForTimeout(16); }
    for (let h = 47; h >= 0; h--) { await page.mouse.move(xAt(h), y); await page.waitForTimeout(16); }
    const dragMs = Date.now() - t0;
    await page.mouse.up();
    await page.evaluate(() => window.__spike.waitIdle());
    page.off('request', countReq);
    const rec = await page.evaluate(() => window.__spike.stop());

    const ok = ticks.filter((t) => t.changed);
    const row = {
      approach, cells: actualCells,
      tick: {
        sync: summary(ticks.map((t) => t.syncMs)),
        firstFrame: summary(ticks.map((t) => t.firstRenderMs)),
        visible: summary(ok.map((t) => t.visibleMs)),
        idle: summary(ticks.map((t) => t.idleMs)),
        changedTicks: ok.length,
      },
      drag: {
        ms: dragMs,
        inputs: rec.inputs.length,
        inputToPaint: summary(rec.inputs),
        frameGap: summary(rec.frames.slice(1)),
        framesOver50: rec.frames.filter((f) => f > 50).length,
        longTasks: rec.longTasks.length,
        longTaskTotal: r1(rec.longTasks.reduce((s, t) => s + t.dur, 0)),
        longTaskMax: r1(Math.max(0, ...rec.longTasks.map((t) => t.dur))),
        mapRenders: rec.renders,
        networkRequests: requests,
      },
      errors,
    };
    results.push(row);
    console.log(JSON.stringify(row));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(OUT, JSON.stringify({ mode: MODE, throttle: THROTTLE, renderer, results }, null, 2));
console.log(`renderer: ${renderer}\nwrote ${OUT}`);
