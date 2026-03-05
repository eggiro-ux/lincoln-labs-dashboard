import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  base: '/dist/',
  build: {
    outDir: resolve(__dirname, '../public/dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        marketing: resolve(__dirname, 'marketing/index.html'),
      },
    },
  },
});
