import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Dev only: forward /api and /health to the local API so the browser sees one origin (the API has no CORS).
  const apiTarget = env.VITE_DEV_API_PROXY || 'http://localhost:3000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/health': apiTarget,
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
