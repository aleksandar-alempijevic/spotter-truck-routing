// Measures a scripted slider drag on the built app: long tasks, input latency, frame gaps and
// network requests, with and without a CPU slowdown. It lives outside `make check`, like the
// backend's live checks, because it needs a browser and a running app.
//
//   1. pnpm -C frontend build
//   2. node scripts/stand-in-server.ts --port 8801 --routes-delay-ms 200 --weather-delay-ms 200 \
//        [--cell-degrees 0.25]
//   3. serve the build with /api proxied to the stand-in (for example `vite preview` with a
//      config whose preview.proxy sends /api to http://127.0.0.1:8801)
//   4. PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs [CHROMIUM=/path/to/chrome] \
//        node scripts/measure-slider.mjs http://127.0.0.1:4180/ [runs] [cpuRate]
//
// DEP_MINUTE=<0-59> pins the departure to that minute past the hour (the form's default is one
// hour ahead). It matters: a departure under 30 minutes past the hour opens the slider at hour 0,
// where no truck is driving, which is the case the trucks-layer warm-up exists for. Measure both,
// for example DEP_MINUTE=10 and DEP_MINUTE=45.
//
// Playwright is not a dependency of the app. Prints one JSON document.
const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const { chromium } = playwright;

const base = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
const cpuRate = Number(process.argv[4] ?? 4);
if (!base) throw new Error('usage: measure-slider.mjs <app url> [runs] [cpuRate]');

const SAMPLES_PER_PASS = 120;

const percentile = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const round = (n) => Math.round(n * 10) / 10;

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function plan(page) {
  await page.goto(base);
  await page.getByLabel('Starting place').fill('Dallas');
  await page.getByRole('option', { name: 'Dallas, TX, United States' }).click();
  await page.getByLabel('Destination').fill('Seattle');
  await page.getByRole('option', { name: 'Seattle, WA, United States' }).click();
  await page.getByLabel('Cargo weight (lb)').fill('36000');
  if (process.env.DEP_MINUTE) {
    await page.getByRole('button', { name: 'Pick a time' }).click();
    const field = page.getByLabel('Departure date and time');
    const value = await field.inputValue();
    await field.fill(value.slice(0, 14) + process.env.DEP_MINUTE.padStart(2, '0'));
  }
  await page.getByRole('button', { name: 'Plan routes' }).click();
  await page.getByRole('slider', { name: 'Forecast hour' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[role=slider]')?.hasAttribute('disabled'),
    null,
    {
      timeout: 30000,
    },
  );
  await page.waitForTimeout(4000); // tiles, first fit and idle work settle before measuring
}

async function oneRun(browser, throttle) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const requests = [];
  let measuring = false;
  page.on('request', (r) => {
    if (measuring) requests.push(new URL(r.url()).pathname.startsWith('/api/') ? 'api' : 'other');
  });
  await plan(page);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

  await page.evaluate(() => {
    window.__m = { longTasks: [], events: [], frames: [], outliers: [] };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__m.longTasks.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.name === 'pointermove') window.__m.events.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 16, buffered: false });
    let last = performance.now();
    const tick = (t) => {
      window.__m.frames.push(t - last);
      if (t - last > 50)
        window.__m.outliers.push({
          at: Math.round(t - window.__m.t0),
          gap: Math.round(t - last),
          hour: document.querySelector('[role=slider]')?.getAttribute('aria-valuenow'),
        });
      last = t;
      if (window.__m.running) requestAnimationFrame(tick);
    };
    window.__m.t0 = performance.now();
    window.__m.running = true;
    requestAnimationFrame(tick);
  });

  const thumb = await page.locator('.MuiSlider-thumb').boundingBox();
  const rail = await page.locator('.MuiSlider-rail').boundingBox();
  const y = thumb.y + thumb.height / 2;
  const left = rail.x;
  const right = rail.x + rail.width;
  const hours = [];

  measuring = true;
  await page.mouse.move(thumb.x + thumb.width / 2, y);
  await page.mouse.down();
  // Up to the last hour, then all the way back: two passes over every hour.
  for (const [from, to] of [
    [left, right],
    [right, left],
  ]) {
    for (let i = 1; i <= SAMPLES_PER_PASS; i++) {
      await page.mouse.move(from + ((to - from) * i) / SAMPLES_PER_PASS, y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
      if (i % 10 === 0)
        hours.push(Number(await page.getByRole('slider').getAttribute('aria-valuenow')));
    }
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  measuring = false;

  const m = await page.evaluate(() => {
    window.__m.running = false;
    return window.__m;
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await context.close();
  return {
    longTasks: m.longTasks.map(round),
    pointermoveEvents: summarize(m.events),
    frameGapsMs: summarize(m.frames),
    frameGapsOver50ms: m.outliers,
    requests: {
      api: requests.filter((r) => r === 'api').length,
      other: requests.filter((r) => r === 'other').length,
    },
    hoursSeen: { min: Math.min(...hours), max: Math.max(...hours) },
  };
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const result = {
  base,
  runs,
  cpuRate,
  samplesPerPass: SAMPLES_PER_PASS,
  throttled: [],
  unthrottled: [],
};
for (let i = 0; i < runs; i++) result.throttled.push(await oneRun(browser, cpuRate));
for (let i = 0; i < runs; i++) result.unthrottled.push(await oneRun(browser, 1));
await browser.close();
console.log(JSON.stringify(result, null, 2));
