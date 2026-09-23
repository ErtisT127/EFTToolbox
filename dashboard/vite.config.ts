import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  define: {
    'globalThis.__EFT_TOOLBOX_DEV__':
      mode !== 'production' || process.env.EFT_TOOLBOX_DASHBOARD_DEV === '1',
  },
}));
