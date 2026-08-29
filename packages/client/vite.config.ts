import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mkcert from 'vite-plugin-mkcert';

/**
 * Mini App URLs must be HTTPS — Telegram will not open an `http://` webview
 * even on localhost. `vite-plugin-mkcert` issues a locally trusted
 * certificate so `pnpm dev` is directly usable from a phone on the same
 * network; the README also covers tunnelling for a device on mobile data.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), mode === 'development' ? mkcert() : undefined].filter(Boolean),

  server: {
    host: true,
    port: 5173,
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Telegram's webview caches aggressively. Content-hashed filenames are
        // what make a deploy actually visible rather than a coin flip; see
        // `vercel.json` for the matching cache headers.
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
      },
    },
  },
}));
