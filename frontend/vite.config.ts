import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The browser only talks to the Vite dev server; /api is forwarded to Django,
// so there is one origin and no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
