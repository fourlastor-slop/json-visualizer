import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs, so the built site works from any path on any static host.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
