import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * Stamps the version into the served HTML.
 *
 * "Is my browser running the build I just deployed?" is otherwise unanswerable
 * without reading response headers, and a stale shell is indistinguishable from
 * a broken deploy. Check it in dev tools, or `curl -s <url> | grep caliper-build`.
 */
function versionStamp(): Plugin {
  return {
    name: 'caliper-version-stamp',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta name="caliper-build" content="${pkg.version}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), versionStamp()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
