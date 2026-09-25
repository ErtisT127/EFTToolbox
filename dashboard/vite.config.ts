import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  define: {
    'globalThis.__EFT_TOOLBOX_DEV__':
      mode !== 'production' || process.env.EFT_TOOLBOX_DASHBOARD_DEV === '1',
  },
  build: {
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(fileURLToPath(new URL('.', import.meta.url)), 'index.html'),
        cast: resolve(fileURLToPath(new URL('.', import.meta.url)), 'cast.html'),
      },
    },
  },
}));
