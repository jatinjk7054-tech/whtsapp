import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // 5173 busy hone par Vite chup-chaap 5174 par na bhage — seedha error de.
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
  };
});