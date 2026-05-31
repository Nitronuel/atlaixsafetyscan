import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api/insightx': {
          target: 'http://127.0.0.1:3101',
          changeOrigin: true
        }
      }
    }
  };
});
