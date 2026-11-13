// A stand-in for the API on :8000, answering from the typed fixtures, so the built app and the
// Vite proxy can be driven in a real browser with no providers and no keys.
//
//   node scripts/stand-in-server.ts [--routes-delay-ms 3000] [--weather-delay-ms 8000] [--port 8000]
//                                   [--weather-error outside_service_area]
//
// With --weather-error the weather endpoint answers 422 with that error code instead.
//
// It prints one JSON line per request. It is a development aid, not part of the app.
import { createServer } from 'node:http';
import { createStandIn } from '../src/test/standIn.ts';

function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const routesDelay = option('routes-delay-ms', 3000);
const weatherDelay = option('weather-delay-ms', 8000);
const port = option('port', 8000);
const answer = createStandIn();
const weatherErrorAt = process.argv.indexOf('--weather-error');
const weatherError = weatherErrorAt === -1 ? null : process.argv[weatherErrorAt + 1];

createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const url = request.url ?? '/';
    const delay = url.startsWith('/api/routes')
      ? routesDelay
      : url.startsWith('/api/weather')
        ? weatherDelay
        : 0;
    console.log(JSON.stringify({ at: new Date().toISOString(), method: request.method, url }));
    setTimeout(() => {
      if (weatherError && url.startsWith('/api/weather')) {
        response.writeHead(422, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ code: weatherError, message: 'Value error, routes: stand-in refusal' }),
        );
        return;
      }
      const reply = answer(request.method ?? 'GET', url, Buffer.concat(chunks).toString('utf8'));
      response.writeHead(reply.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    }, delay);
  });
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ listening: port })));
