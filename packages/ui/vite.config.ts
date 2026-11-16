import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev:ui` serves the UI with hot reload and proxies the API to a
// server started separately with `npm run simulate`.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
