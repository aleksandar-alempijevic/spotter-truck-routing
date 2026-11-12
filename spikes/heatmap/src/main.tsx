import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

// The map (and MapLibre) load as a separate chunk so its size is visible in the build output.
const App = lazy(() => import('./App'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<p style={{ font: '14px system-ui' }}>Loading map…</p>}>
      <App />
    </Suspense>
  </StrictMode>,
);
